/**
 * Phase 2 Git Worktree 隔离、并行写入与自动合入主工作区验证。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createTestBackend, SecretStore } from "../../src/host/boot/secrets.js";
import { AgentNetworkProxy } from "../../src/host/delegation/network-proxy.js";
import { ProviderSelect } from "../../src/host/delegation/provider-select.js";
import { DelegationRunner } from "../../src/host/delegation/run.js";
import { AgentSandboxPreferences } from "../../src/host/delegation/sandbox-preferences.js";
import { SessionStore } from "../../src/host/session/store.js";
import { WorkspaceLocks } from "../../src/host/workspace/locks.js";
import {
  applyTaskWorktree,
  createTaskWorktree,
  diffTaskWorktree,
  pruneFinishedWorktrees,
  readWorktreeMeta,
  recoverOrphanedWorktrees,
  removeTaskWorktree,
} from "../../src/host/workspace/worktree.js";
import type { DelegationProvider } from "../../src/shared/domain/provider.js";
import { AgentSandboxProfileSchema } from "../../src/shared/domain/sandbox.js";
import { makeTempHome } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn().catch(() => undefined);
  }
});

function initGitWorkspace(): string {
  const repo = join(tmpdir(), `sc-wt-repo-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(repo, { recursive: true });
  cleanups.push(async () => rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(join(repo, "shared.txt"), "line1\nline2\nline3\n", "utf8");
  execFileSync("git", ["add", "shared.txt"], { cwd: repo });
  execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: repo });
  return repo;
}

describe("Git Worktree Isolation & Auto-Merge", () => {
  it("isolates edits in worktree, auto-merges clean changes, and preserves conflicting worktrees", async () => {
    const temp = makeTempHome("sc-wt-");
    cleanups.push(async () => temp.cleanup());
    const repo = initGitWorkspace();

    const created = await createTaskWorktree({
      worktreesDir: temp.paths.worktreesDir,
      workspaceId: "ws1",
      sessionId: "s1",
      taskId: "t_clean",
      workspaceRoot: repo,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    writeFileSync(join(created.value.worktreePath, "shared.txt"), "line1\nline2-edited\nline3\n", "utf8");
    writeFileSync(join(created.value.worktreePath, "new-file.ts"), "export const x = 1;\n", "utf8");

    // 合入前主工作区保持干净
    expect(existsSync(join(repo, "new-file.ts"))).toBe(false);
    expect(readFileSync(join(repo, "shared.txt"), "utf8").trim()).toBe("line1\nline2\nline3");

    const applied = await applyTaskWorktree(temp.paths.worktreesDir, created.value);
    expect(applied.applied).toBe(true);
    expect(applied.files.sort()).toEqual(["new-file.ts", "shared.txt"]);
    expect(existsSync(join(repo, "new-file.ts"))).toBe(true);
    expect(readFileSync(join(repo, "shared.txt"), "utf8")).toContain("line2-edited");
    expect(existsSync(created.value.worktreePath)).toBe(false);

    // 制造冲突场景
    const conflicting = await createTaskWorktree({
      worktreesDir: temp.paths.worktreesDir,
      workspaceId: "ws1",
      sessionId: "s1",
      taskId: "t_conflict",
      workspaceRoot: repo,
    });
    expect(conflicting.ok).toBe(true);
    if (!conflicting.ok) return;

    writeFileSync(join(repo, "shared.txt"), "line1-main\nline2-edited\nline3\n", "utf8");
    writeFileSync(join(conflicting.value.worktreePath, "shared.txt"), "line1-agent\nline2-edited\nline3\n", "utf8");

    const conflictResult = await applyTaskWorktree(temp.paths.worktreesDir, conflicting.value);
    expect(conflictResult.applied).toBe(false);
    if (!conflictResult.applied) expect(conflictResult.conflict).toBe(true);
    // 主工作区未被部分覆盖，worktree 完整保留且可读 diff
    expect(readFileSync(join(repo, "shared.txt"), "utf8")).toContain("line1-main");
    expect(existsSync(conflicting.value.worktreePath)).toBe(true);

    const diff = await diffTaskWorktree(temp.paths.worktreesDir, "ws1", "t_conflict");
    expect(diff.ok).toBe(true);
    if (diff.ok) {
      expect(diff.value.state).toBe("conflict");
      expect(diff.value.patch).toContain("line1-agent");
    }

    await removeTaskWorktree(temp.paths.worktreesDir, conflicting.value, "discarded");
    expect(existsSync(conflicting.value.worktreePath)).toBe(false);
  });

  it("keeps diffTaskWorktree strictly read-only and preserves filenames with commas in task view", async () => {
    const temp = makeTempHome("sc-wt-ro-");
    cleanups.push(async () => temp.cleanup());
    const repo = initGitWorkspace();

    const created = await createTaskWorktree({
      worktreesDir: temp.paths.worktreesDir,
      workspaceId: "ws1",
      sessionId: "s1",
      taskId: "t_ro",
      workspaceRoot: repo,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    writeFileSync(join(created.value.worktreePath, "shared.txt"), "line1\nline2-ro\nline3\n", "utf8");
    writeFileSync(join(created.value.worktreePath, "a,b.txt"), "comma filename\n", "utf8");

    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: created.value.worktreePath, encoding: "utf8" }).trim();
    const diff = await diffTaskWorktree(temp.paths.worktreesDir, "ws1", "t_ro");
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: created.value.worktreePath, encoding: "utf8" }).trim();
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: created.value.worktreePath, encoding: "utf8" }).trim();

    expect(headAfter).toBe(headBefore);
    expect(untracked).toBe("a,b.txt");
    expect(diff.ok).toBe(true);
    if (diff.ok) {
      expect(diff.value.files.sort()).toEqual(["a,b.txt", "shared.txt"]);
      expect(diff.value.patch).toContain("line2-ro");
      expect(diff.value.patch).toContain("a,b.txt");
    }

    const applied = await applyTaskWorktree(temp.paths.worktreesDir, created.value);
    expect(applied.applied).toBe(true);
    expect(applied.files.sort()).toEqual(["a,b.txt", "shared.txt"]);

    const sessions = new SessionStore({ paths: temp.paths, logger: silentLogger() });
    const { sessionId } = sessions.create("ws1");
    const session = sessions.get(sessionId);
    session.append("delegation/spawn", {
      childId: "t_ro",
      provider: "stub",
      agentId: "agent-1",
      instruction: "",
      goal: "test",
      mode: "write",
    });
    session.append("delegation/progress", {
      childId: "t_ro",
      event: { type: "trace", summary: `worktree:merged:${JSON.stringify(["a,b.txt", "shared.txt"])}` },
    });
    const viewTask = session.view().tasks.find((t) => t.taskId === "t_ro");
    expect(viewTask?.worktree?.files).toEqual(["a,b.txt", "shared.txt"]);
  });

  it("allows parallel write tasks in worktree mode and auto-merges both without busy conflict", async () => {
    const temp = makeTempHome("sc-wt-parallel-");
    const proxy = new AgentNetworkProxy();
    cleanups.push(async () => {
      await proxy.close();
      temp.cleanup();
    });
    const repo = initGitWorkspace();

    const logger = silentLogger();
    const secrets = new SecretStore(temp.paths.secretsFile, createTestBackend());
    const sandboxes = new AgentSandboxPreferences({
      file: join(temp.home, "agent-sandboxes.json"),
      secrets,
      sandboxesDir: temp.paths.sandboxesDir,
    });
    for (const id of ["agent-1", "agent-2"]) {
      sandboxes.set(id, AgentSandboxProfileSchema.parse({ workspace: { isolation: "worktree" } }));
    }

    let barrierRelease: (() => void) | null = null;
    let entered = 0;
    const bothInside = new Promise<void>((resolve) => {
      barrierRelease = resolve;
    });

    const makeWorker = (id: string, filename: string): DelegationProvider => ({
      id,
      capabilities: {
        readOnly: false,
        resume: false,
        effort: false,
        streaming: false,
        receiptStates: ["queued", "submitted", "returned"],
        fragility: "official",
      },
      supportsSandbox: { env: true, network: true, worktree: true },
      detect: async () => ({ installed: true, binaryPath: id }),
      listSessions: async () => [],
      readSession: async () => [],
      cancel: async () => undefined,
      delegate: async (req) => {
        entered += 1;
        if (entered === 2) barrierRelease?.();
        await bothInside;
        req.onEvent({ type: "trace", summary: "delivery:queued" });
        req.onEvent({ type: "trace", summary: "delivery:submitted" });
        writeFileSync(join(req.workspace, filename), `created by ${id}\n`, "utf8");
        req.onEvent({ type: "trace", summary: "delivery:returned" });
        return { status: "ok", answer: `done ${filename}`, durationMs: 5 };
      },
    });

    const select = new ProviderSelect([
      {
        id: "agent-1",
        label: "Agent 1",
        entries: [{ level: 1, provider: makeWorker("agent-1", "a1.txt") }],
        probe: { providerId: "agent-1", locate: async () => null, listSessions: async () => [], readSession: async () => [] },
      },
      {
        id: "agent-2",
        label: "Agent 2",
        entries: [{ level: 1, provider: makeWorker("agent-2", "a2.txt") }],
        probe: { providerId: "agent-2", locate: async () => null, listSessions: async () => [], readSession: async () => [] },
      },
    ]);

    const sessions = new SessionStore({ paths: temp.paths, logger });
    const { sessionId } = sessions.create("ws1");
    const session = sessions.get(sessionId);

    const runner = new DelegationRunner({
      select,
      locks: new WorkspaceLocks(),
      logger,
      sandboxes,
      networkProxy: proxy,
      worktreesDir: temp.paths.worktreesDir,
    });

    const [t1, t2] = await Promise.all([
      runner.dispatch({
        session,
        workspaceId: "ws1",
        workspacePath: repo,
        agentId: "agent-1",
        goal: "write a1",
        instruction: "",
        mode: "write",
        taskType: "implement",
        signal: new AbortController().signal,
      }),
      runner.dispatch({
        session,
        workspaceId: "ws1",
        workspacePath: repo,
        agentId: "agent-2",
        goal: "write a2",
        instruction: "",
        mode: "write",
        taskType: "implement",
        signal: new AbortController().signal,
      }),
    ]);

    expect(t1.state).toBe("returned");
    expect(t2.state).toBe("returned");
    expect(t1.worktree?.state).toBe("merged");
    expect(t2.worktree?.state).toBe("merged");
    expect(existsSync(join(repo, "a1.txt"))).toBe(true);
    expect(existsSync(join(repo, "a2.txt"))).toBe(true);
    expect(readFileSync(join(repo, "a1.txt"), "utf8").trim()).toBe("created by agent-1");
    expect(readFileSync(join(repo, "a2.txt"), "utf8").trim()).toBe("created by agent-2");
  });

  it("recovers crashed active worktrees on startup and prunes finished worktrees", async () => {
    const temp = makeTempHome("sc-wt-recover-");
    cleanups.push(async () => temp.cleanup());
    const repo = initGitWorkspace();

    const crashedKept = await createTaskWorktree({
      worktreesDir: temp.paths.worktreesDir,
      workspaceId: "ws1",
      sessionId: "s1",
      taskId: "t_crash_kept",
      workspaceRoot: repo,
    });
    expect(crashedKept.ok).toBe(true);
    if (!crashedKept.ok) return;
    writeFileSync(join(crashedKept.value.worktreePath, "draft.txt"), "unsaved work\n", "utf8");

    const crashedMissing = await createTaskWorktree({
      worktreesDir: temp.paths.worktreesDir,
      workspaceId: "ws1",
      sessionId: "s1",
      taskId: "t_crash_missing",
      workspaceRoot: repo,
    });
    expect(crashedMissing.ok).toBe(true);
    if (!crashedMissing.ok) return;
    rmSync(crashedMissing.value.worktreePath, { recursive: true, force: true });

    const recovery = await recoverOrphanedWorktrees(temp.paths.worktreesDir);
    expect(recovery).toEqual({ recovered: 1, discarded: 1 });

    const recoveredMeta = readWorktreeMeta(temp.paths.worktreesDir, "ws1", "t_crash_kept");
    expect(recoveredMeta?.state).toBe("kept");
    expect(recoveredMeta?.files).toContain("draft.txt");

    const missingMeta = readWorktreeMeta(temp.paths.worktreesDir, "ws1", "t_crash_missing");
    expect(missingMeta?.state).toBe("discarded");

    // 默认 prune 只清理 merged/discarded，不动 kept
    const pruneDefault = await pruneFinishedWorktrees(temp.paths.worktreesDir, { includeKept: false });
    expect(pruneDefault.removed).toBe(1);
    expect(readWorktreeMeta(temp.paths.worktreesDir, "ws1", "t_crash_missing")).toBeNull();
    expect(readWorktreeMeta(temp.paths.worktreesDir, "ws1", "t_crash_kept")?.state).toBe("kept");

    // includeKept: true 彻底清理遗留 kept 工作树、分支与元数据
    const pruneAll = await pruneFinishedWorktrees(temp.paths.worktreesDir, { includeKept: true });
    expect(pruneAll.removed).toBe(1);
    expect(readWorktreeMeta(temp.paths.worktreesDir, "ws1", "t_crash_kept")).toBeNull();
    expect(existsSync(crashedKept.value.worktreePath)).toBe(false);
  });
});
