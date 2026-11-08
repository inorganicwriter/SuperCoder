/**
 * 工作区状态回撤：差异化检测与安全检出恢复。
 * 非 git 工作区由调用方中止——这里验证两个纯动作与它们的边界。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectRewindCandidates } from "../../src/host/workspace/rewind.js";
import { isGitRepo, restoreFiles } from "../../src/host/workspace/git.js";
import type { SessionEvent } from "../../src/shared/session/events.js";

let root = "";

function snapshot(seq: number, files: Array<{ path: string; mtimeMs: number; size: number }>): SessionEvent {
  return {
    seq,
    at: "2026-01-01T00:00:00.000Z",
    sessionId: "s1",
    type: "snapshot/taken",
    taskId: "t1",
    files,
  } as unknown as SessionEvent;
}

function stat(path: string): { mtimeMs: number; size: number } {
  const info = statSync(join(root, path));
  return { mtimeMs: info.mtimeMs, size: info.size };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sc-rewind-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Workspace State Restoration", () => {
  it("identifies only modified and deleted files as rewind candidates", () => {
    writeFileSync(join(root, "changed.txt"), "初版");
    writeFileSync(join(root, "untouched.txt"), "别动我");
    writeFileSync(join(root, "gone.txt"), "马上删");
    const changed = stat("changed.txt");
    const untouched = stat("untouched.txt");
    const gone = stat("gone.txt");

    writeFileSync(join(root, "changed.txt"), "被改过了");
    rmSync(join(root, "gone.txt"));

    const events = [
      snapshot(1, [
        { path: "changed.txt", ...changed },
        { path: "untouched.txt", ...untouched },
        { path: "gone.txt", ...gone },
      ]),
    ];
    expect(collectRewindCandidates(events, 0, root).sort()).toEqual(["changed.txt", "gone.txt"]);
  });

  it("excludes files modified prior to target toSeq sequence", () => {
    writeFileSync(join(root, "a.txt"), "初版");
    const before = stat("a.txt");
    // 故意改成长度不同的内容：快照只有 mtime+size，同尺寸同毫秒的改写分辨不出来。
    writeFileSync(join(root, "a.txt"), "改过了，内容更长");
    const events = [snapshot(3, [{ path: "a.txt", ...before }])];
    expect(collectRewindCandidates(events, 3, root)).toEqual([]);
    expect(collectRewindCandidates(events, 2, root)).toEqual(["a.txt"]);
  });

  it("restores modified tracked files back to HEAD in git repository", async () => {
    mkdirSync(join(root, ".git"), { recursive: true });
    rmSync(join(root, ".git"), { recursive: true, force: true });
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "a.txt"), "初版\n");
    execFileSync("git", ["add", "a.txt"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: root });

    expect(isGitRepo(root)).toBe(true);
    writeFileSync(join(root, "a.txt"), "被 Agent 改坏了\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toContain("改坏了");

    const result = await restoreFiles(root, ["a.txt"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.restored).toEqual(["a.txt"]);
    expect(readFileSync(join(root, "a.txt"), "utf8").trim()).toBe("初版");
  });

  it("provides actionable message instead of false success for non-git workspaces", async () => {
    writeFileSync(join(root, "a.txt"), "x");
    const result = await restoreFiles(root, ["a.txt"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("git");
      expect(result.error).toContain("Git 仓库");
    }
  });

  it("succeeds immediately without invoking git when no files require restoration", async () => {
    const result = await restoreFiles(root, []);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.restored).toEqual([]);
  });
});
