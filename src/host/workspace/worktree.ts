/**
 * Phase 2：Git Worktree 工作区隔离与自动合入。
 *
 * - 每个隔离写任务在 `<worktreesDir>/<workspaceId>/<taskId>` 拥有独立工作树与临时分支，
 *   避免与并行任务争抢主工作区。
 * - 任务成功完成且无冲突时，自动通过 `git apply` 合入主工作区并清理 worktree。
 * - 若有冲突或任务失败/中断，保留现场并生成 diff 供人工审阅、手动应用或丢弃。
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TaskWorktreeState } from "../../shared/domain/sandbox.js";
import { err, ok, type Result } from "../../shared/result.js";
import { ensureDir, writeJsonAtomic } from "../boot/atomic.js";
import { runProcess } from "../boot/exec.js";
import { isSafeId } from "../boot/paths.js";
import { isGitRepo } from "./git.js";

export interface WorktreeMeta {
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly state: TaskWorktreeState;
  readonly createdAt: string;
  readonly files?: readonly string[];
  readonly message?: string;
}

export interface WorktreeDiff {
  readonly state: TaskWorktreeState;
  readonly branch?: string;
  readonly files: string[];
  readonly stat: string;
  readonly patch: string;
  readonly message?: string;
}

export type WorktreeApplyOutcome =
  | { readonly applied: true; readonly files: string[]; readonly message: string }
  | { readonly applied: false; readonly conflict: boolean; readonly files: string[]; readonly message: string };

const MAX_DIFF_PREVIEW_BYTES = 200 * 1024;

export function worktreeMetaFile(worktreesDir: string, workspaceId: string, taskId: string): string {
  if (!isSafeId(workspaceId) || !isSafeId(taskId)) {
    throw new Error(`非法 worktree 标识：${workspaceId}/${taskId}`);
  }
  return join(worktreesDir, workspaceId, `${taskId}.meta.json`);
}

export function readWorktreeMeta(
  worktreesDir: string,
  workspaceId: string,
  taskId: string,
): WorktreeMeta | null {
  try {
    const file = worktreeMetaFile(worktreesDir, workspaceId, taskId);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as WorktreeMeta;
  } catch {
    return null;
  }
}

export function writeWorktreeMeta(worktreesDir: string, meta: WorktreeMeta): void {
  const file = worktreeMetaFile(worktreesDir, meta.workspaceId, meta.taskId);
  ensureDir(dirname(file));
  writeJsonAtomic(file, meta);
}

export async function createTaskWorktree(input: {
  readonly worktreesDir: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly taskId: string;
  readonly workspaceRoot: string;
}): Promise<Result<WorktreeMeta, string>> {
  if (!isSafeId(input.workspaceId) || !isSafeId(input.taskId)) {
    return err("任务或工作区标识不合法，无法创建隔离工作区。");
  }
  if (!isGitRepo(input.workspaceRoot)) {
    return err("当前工作区未初始化 Git 仓库，无法启用 Git Worktree 隔离。请先初始化 Git 或切换回共享工作区。");
  }
  const head = await runProcess("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: input.workspaceRoot,
    timeoutMs: 15_000,
  });
  if (head.code !== 0) {
    return err("当前 Git 仓库尚无提交记录，无法创建隔离 worktree。请先提交初始 commit，或切换回共享工作区。");
  }
  const baseCommit = head.stdout.trim();
  const wsDir = join(input.worktreesDir, input.workspaceId);
  ensureDir(wsDir);
  const worktreePath = join(wsDir, input.taskId);
  const branch = `supercoder/task/${input.taskId}`;

  // 清理同名残留（若之前崩溃留下）
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    await runProcess("git", ["worktree", "prune"], { cwd: input.workspaceRoot, timeoutMs: 15_000 });
  }
  await runProcess("git", ["branch", "-D", branch], { cwd: input.workspaceRoot, timeoutMs: 10_000 });

  const add = await runProcess(
    "git",
    ["worktree", "add", "-b", branch, worktreePath, baseCommit],
    { cwd: input.workspaceRoot, timeoutMs: 30_000 },
  );
  if (add.code !== 0) {
    return err(`创建 Git worktree 失败：${(add.stderr || add.stdout).trim().slice(0, 200)}`);
  }

  const meta: WorktreeMeta = {
    taskId: input.taskId,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    workspaceRoot: input.workspaceRoot,
    worktreePath,
    branch,
    baseCommit,
    state: "active",
    createdAt: new Date().toISOString(),
  };
  writeWorktreeMeta(input.worktreesDir, meta);
  return ok(meta);
}

/** 将隔离 worktree 中未暂存/新创建的变更提交到临时分支，统一用 baseCommit..HEAD 计算完整差异。 */
export async function commitWorktreeChanges(
  meta: WorktreeMeta,
): Promise<Result<{ readonly hasChanges: boolean; readonly commitRef: string; readonly files: string[] }, string>> {
  if (!existsSync(meta.worktreePath)) {
    return err("隔离 worktree 目录已不存在，无法提交变更。");
  }
  const status = await runProcess("git", ["status", "--porcelain"], {
    cwd: meta.worktreePath,
    timeoutMs: 20_000,
  });
  if (status.code !== 0) {
    return err(`读取隔离工作区状态失败：${(status.stderr || status.stdout).trim().slice(0, 200)}`);
  }
  if (status.stdout.trim() !== "") {
    const add = await runProcess("git", ["add", "-A"], { cwd: meta.worktreePath, timeoutMs: 30_000 });
    if (add.code !== 0) {
      return err(`暂存隔离工作区变更失败：${(add.stderr || add.stdout).trim().slice(0, 200)}`);
    }
    const commit = await runProcess(
      "git",
      [
        "-c",
        "user.name=SuperCoder",
        "-c",
        "user.email=supercoder@local",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        `supercoder task ${meta.taskId}`,
      ],
      { cwd: meta.worktreePath, timeoutMs: 30_000 },
    );
    const commitOutput = (commit.stderr || commit.stdout).trim();
    if (commit.code !== 0 && !/nothing to commit/i.test(commitOutput)) {
      return err(`提交隔离工作区变更失败：${commitOutput.slice(0, 200)}`);
    }
  }

  const changed = await runProcess(
    "git",
    ["diff", "--name-only", `${meta.baseCommit}..HEAD`],
    { cwd: meta.worktreePath, timeoutMs: 20_000 },
  );
  if (changed.code !== 0) {
    return err(`计算隔离工作区变更列表失败：${(changed.stderr || changed.stdout).trim().slice(0, 200)}`);
  }
  const files = changed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const head = await runProcess("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: meta.worktreePath,
    timeoutMs: 10_000,
  });
  if (head.code !== 0) {
    return err(`读取隔离工作区 HEAD 失败：${(head.stderr || head.stdout).trim().slice(0, 200)}`);
  }
  const commitRef = head.stdout.trim();
  return ok({ hasChanges: files.length > 0, commitRef, files });
}

export async function diffTaskWorktree(
  worktreesDir: string,
  workspaceId: string,
  taskId: string,
): Promise<Result<WorktreeDiff, string>> {
  const meta = readWorktreeMeta(worktreesDir, workspaceId, taskId);
  if (meta === null) {
    return err(`未找到任务 ${taskId} 的隔离工作区记录。`);
  }
  if (!existsSync(meta.worktreePath)) {
    return ok({
      state: meta.state,
      branch: meta.branch,
      files: [...(meta.files ?? [])],
      stat: "",
      patch: "",
      ...(meta.message === undefined ? {} : { message: meta.message }),
    });
  }

  // 严格只读查询：绝不修改工作区或创建 Git 提交，避免干扰运行中的外部 Agent。
  const [trackedNamesRes, untrackedRes, statRes, patchRes] = await Promise.all([
    runProcess("git", ["diff", "--name-only", meta.baseCommit], {
      cwd: meta.worktreePath,
      timeoutMs: 20_000,
    }),
    runProcess("git", ["ls-files", "--others", "--exclude-standard"], {
      cwd: meta.worktreePath,
      timeoutMs: 20_000,
    }),
    runProcess("git", ["diff", "--stat", meta.baseCommit], {
      cwd: meta.worktreePath,
      timeoutMs: 20_000,
    }),
    runProcess("git", ["diff", meta.baseCommit], {
      cwd: meta.worktreePath,
      timeoutMs: 30_000,
      maxOutputBytes: MAX_DIFF_PREVIEW_BYTES,
    }),
  ]);

  const trackedFiles = trackedNamesRes.code === 0
    ? trackedNamesRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "")
    : [];
  const untrackedFiles = untrackedRes.code === 0
    ? untrackedRes.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "")
    : [];
  const files = [...new Set([...trackedFiles, ...untrackedFiles])];

  if (files.length === 0) {
    return ok({
      state: meta.state,
      branch: meta.branch,
      files: [],
      stat: "",
      patch: "",
      ...(meta.message === undefined ? {} : { message: meta.message }),
    });
  }

  const statParts = [statRes.stdout.trim()];
  if (untrackedFiles.length > 0) {
    statParts.push(`Untracked files:\n${untrackedFiles.map((file) => `  + ${file}`).join("\n")}`);
  }
  const stat = statParts.filter((part) => part !== "").join("\n");

  let patch = patchRes.overflowed
    ? `${patchRes.stdout}\n\n... (diff 已超过 ${Math.round(MAX_DIFF_PREVIEW_BYTES / 1024)} KB 预览上限，已截断)`
    : patchRes.stdout;
  if (!patchRes.overflowed && untrackedFiles.length > 0) {
    const untrackedBlock = untrackedFiles.map((file) => `+++ b/${file} (untracked)`).join("\n");
    patch = patch.trim() === "" ? untrackedBlock : `${patch.trimEnd()}\n\n${untrackedBlock}`;
  }

  return ok({
    state: meta.state,
    branch: meta.branch,
    files,
    stat,
    patch,
    ...(meta.message === undefined ? {} : { message: meta.message }),
  });
}

async function cleanupWorktreeDirAndBranch(meta: WorktreeMeta): Promise<void> {
  if (existsSync(meta.worktreePath)) {
    const removed = await runProcess("git", ["worktree", "remove", "--force", meta.worktreePath], {
      cwd: meta.workspaceRoot,
      timeoutMs: 30_000,
    });
    if (removed.code !== 0 && existsSync(meta.worktreePath)) {
      rmSync(meta.worktreePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      await runProcess("git", ["worktree", "prune"], {
        cwd: meta.workspaceRoot,
        timeoutMs: 15_000,
      });
    }
  } else {
    await runProcess("git", ["worktree", "prune"], {
      cwd: meta.workspaceRoot,
      timeoutMs: 15_000,
    });
  }
  await runProcess("git", ["branch", "-D", meta.branch], {
    cwd: meta.workspaceRoot,
    timeoutMs: 15_000,
  });
}

export async function applyTaskWorktree(
  worktreesDir: string,
  meta: WorktreeMeta,
  options: { readonly removeOnSuccess?: boolean } = {},
): Promise<WorktreeApplyOutcome> {
  if (!existsSync(meta.worktreePath)) {
    return {
      applied: false,
      conflict: false,
      files: [...(meta.files ?? [])],
      message: "隔离 worktree 目录已不存在，无法合入。",
    };
  }

  const committed = await commitWorktreeChanges(meta);
  if (!committed.ok) {
    writeWorktreeMeta(worktreesDir, {
      ...meta,
      state: "kept",
      files: [...(meta.files ?? [])],
      message: committed.error,
    });
    return {
      applied: false,
      conflict: false,
      files: [...(meta.files ?? [])],
      message: committed.error,
    };
  }
  const snapshot = committed.value;
  if (!snapshot.hasChanges) {
    if (options.removeOnSuccess !== false) {
      await cleanupWorktreeDirAndBranch(meta);
    }
    writeWorktreeMeta(worktreesDir, {
      ...meta,
      state: "merged",
      files: [],
      message: "隔离工作区无文件变更",
    });
    return { applied: true, files: [], message: "隔离工作区无文件变更" };
  }

  const patchDir = join(tmpdir(), "supercoder-patches");
  mkdirSync(patchDir, { recursive: true });
  const patchFile = join(patchDir, `${meta.taskId}-${Date.now()}.patch`);

  try {
    const gen = await runProcess(
      "git",
      ["diff", "--binary", `--output=${patchFile}`, meta.baseCommit, snapshot.commitRef],
      { cwd: meta.worktreePath, timeoutMs: 30_000 },
    );
    if (gen.code !== 0 || !existsSync(patchFile)) {
      const msg = `生成隔离补丁失败：${(gen.stderr || gen.stdout).trim().slice(0, 300)}`;
      writeWorktreeMeta(worktreesDir, { ...meta, state: "kept", files: snapshot.files, message: msg });
      return { applied: false, conflict: false, files: snapshot.files, message: msg };
    }

    const check = await runProcess(
      "git",
      ["apply", "--check", "--whitespace=nowarn", patchFile],
      { cwd: meta.workspaceRoot, timeoutMs: 30_000 },
    );
    if (check.code !== 0) {
      const detail = (check.stderr || check.stdout).trim().slice(0, 400);
      const msg = `与主工作区存在冲突，已保留隔离工作区（分支 ${meta.branch}）：${detail || "git apply 校验失败"}`;
      writeWorktreeMeta(worktreesDir, { ...meta, state: "conflict", files: snapshot.files, message: msg });
      return { applied: false, conflict: true, files: snapshot.files, message: msg };
    }

    const apply = await runProcess(
      "git",
      ["apply", "--whitespace=nowarn", patchFile],
      { cwd: meta.workspaceRoot, timeoutMs: 30_000 },
    );
    if (apply.code !== 0) {
      const detail = (apply.stderr || apply.stdout).trim().slice(0, 400);
      const msg = `应用变更到主工作区失败，已保留隔离工作区：${detail}`;
      writeWorktreeMeta(worktreesDir, { ...meta, state: "conflict", files: snapshot.files, message: msg });
      return { applied: false, conflict: true, files: snapshot.files, message: msg };
    }

    if (options.removeOnSuccess !== false) {
      await cleanupWorktreeDirAndBranch(meta);
    }
    const msg = `已自动合入 ${snapshot.files.length} 个文件`;
    writeWorktreeMeta(worktreesDir, {
      ...meta,
      state: "merged",
      files: snapshot.files,
      message: msg,
    });
    return { applied: true, files: snapshot.files, message: msg };
  } finally {
    rmSync(patchFile, { force: true });
  }
}

export async function removeTaskWorktree(
  worktreesDir: string,
  meta: WorktreeMeta,
  finalState: "discarded" | "merged" = "discarded",
): Promise<void> {
  await cleanupWorktreeDirAndBranch(meta);
  writeWorktreeMeta(worktreesDir, {
    ...meta,
    state: finalState,
    ...(finalState === "discarded" ? { message: "已丢弃隔离工作区变更" } : {}),
  });
}
