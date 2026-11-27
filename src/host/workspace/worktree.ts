/**
 * Phase 2：Git Worktree 工作区隔离与自动合入。
 *
 * - 每个隔离写任务在 `<worktreesDir>/<workspaceId>/<taskId>` 拥有独立工作树与临时分支，
 *   避免与并行任务争抢主工作区。
 * - 任务成功完成且无冲突时，自动通过 `git apply` 合入主工作区并清理 worktree。
 * - 若有冲突或任务失败/中断，保留现场并生成 diff 供人工审阅、手动应用或丢弃。
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
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

interface RawDiffEntry {
  readonly oldMode: string;
  readonly newMode: string;
  readonly status: string;
  readonly path: string;
}

type PlannedMergeOp =
  | { readonly kind: "write"; readonly path: string; readonly content: Buffer }
  | { readonly kind: "delete"; readonly path: string };

type ThreeWayMergeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly conflictingFiles: string[]; readonly error?: string };

function resolveInsideRoot(root: string, relPath: string): string | null {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, relPath);
  const rel = relative(resolvedRoot, resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

function inspectPathKind(target: string): "missing" | "file" | "other" {
  try {
    const st = lstatSync(target);
    return st.isFile() ? "file" : "other";
  } catch {
    return "missing";
  }
}

function parseRawDiffZ(stdout: string): RawDiffEntry[] | null {
  const tokens = stdout.split("\0");
  const entries: RawDiffEntry[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const header = tokens[i] ?? "";
    if (header === "") break;
    const filePath = tokens[i + 1] ?? "";
    if (filePath === "") return null;
    const match = /^:([0-7]+)\s+([0-7]+)\s+[0-9a-f]+\s+[0-9a-f]+\s+([A-Z]\d*)$/.exec(header);
    if (match === null) return null;
    entries.push({
      oldMode: match[1]!,
      newMode: match[2]!,
      status: match[3]!,
      path: filePath,
    });
  }
  return entries;
}

function parseBinaryNumstatZ(stdout: string): Set<string> {
  const binaries = new Set<string>();
  for (const record of stdout.split("\0")) {
    if (record === "") continue;
    const match = /^-\t-\t(.+)$/.exec(record);
    if (match !== null) binaries.add(match[1]!);
  }
  return binaries;
}

/**
 * 零污染三方文本自动合并回退：
 * - 全部读取与 `git merge-file -p` 计算在临时目录完成，不写入 `.git/index` 或未完成文件；
 * - 对二进制、重命名/符号链接、路径越界或任意冲突文件整批拒绝，全部无冲突后原子落盘并支持回滚。
 */
async function tryThreeWayMerge(
  meta: WorktreeMeta,
  commitRef: string,
): Promise<ThreeWayMergeResult> {
  const [rawRes, numstatRes] = await Promise.all([
    runProcess(
      "git",
      ["diff", "--raw", "-z", "--no-renames", meta.baseCommit, commitRef],
      { cwd: meta.worktreePath, timeoutMs: 20_000 },
    ),
    runProcess(
      "git",
      ["diff", "--numstat", "-z", "--no-renames", meta.baseCommit, commitRef],
      { cwd: meta.worktreePath, timeoutMs: 20_000 },
    ),
  ]);
  if (rawRes.code !== 0 || rawRes.overflowed || numstatRes.code !== 0 || numstatRes.overflowed) {
    return { ok: false, conflictingFiles: [], error: "读取隔离工作区差异元数据失败" };
  }

  const entries = parseRawDiffZ(rawRes.stdout);
  if (entries === null || entries.length === 0) {
    return { ok: false, conflictingFiles: [], error: "解析隔离工作区变更列表失败" };
  }
  const binaryFiles = parseBinaryNumstatZ(numstatRes.stdout);

  const mergeDir = join(
    tmpdir(),
    `supercoder-merge-${meta.taskId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  );
  mkdirSync(mergeDir, { recursive: true });

  const plannedOps: PlannedMergeOp[] = [];
  const conflictingFiles: string[] = [];

  try {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      if (
        (entry.status !== "A" && entry.status !== "M" && entry.status !== "D") ||
        entry.oldMode === "120000" ||
        entry.newMode === "120000" ||
        entry.oldMode === "160000" ||
        entry.newMode === "160000"
      ) {
        conflictingFiles.push(entry.path);
        continue;
      }

      const mainPath = resolveInsideRoot(meta.workspaceRoot, entry.path);
      const wtPath = resolveInsideRoot(meta.worktreePath, entry.path);
      if (mainPath === null || wtPath === null) {
        conflictingFiles.push(entry.path);
        continue;
      }

      if (entry.status === "A") {
        if (inspectPathKind(wtPath) !== "file") {
          conflictingFiles.push(entry.path);
          continue;
        }
        const mainKind = inspectPathKind(mainPath);
        if (mainKind === "other") {
          conflictingFiles.push(entry.path);
          continue;
        }
        const theirsBuf = readFileSync(wtPath);
        if (mainKind === "missing") {
          plannedOps.push({ kind: "write", path: mainPath, content: theirsBuf });
        } else if (!readFileSync(mainPath).equals(theirsBuf)) {
          conflictingFiles.push(entry.path);
        }
        continue;
      }

      if (entry.status === "D") {
        const mainKind = inspectPathKind(mainPath);
        if (mainKind === "missing") continue;
        if (mainKind === "other" || binaryFiles.has(entry.path)) {
          conflictingFiles.push(entry.path);
          continue;
        }
        const oursBuf = readFileSync(mainPath);
        if (oursBuf.includes(0)) {
          conflictingFiles.push(entry.path);
          continue;
        }
        const baseRes = await runProcess("git", ["show", `${meta.baseCommit}:${entry.path}`], {
          cwd: meta.worktreePath,
          timeoutMs: 20_000,
        });
        if (
          baseRes.code !== 0 ||
          baseRes.overflowed ||
          oursBuf.toString("utf8").replace(/\r\n/g, "\n") !== baseRes.stdout.replace(/\r\n/g, "\n")
        ) {
          conflictingFiles.push(entry.path);
          continue;
        }
        plannedOps.push({ kind: "delete", path: mainPath });
        continue;
      }

      // entry.status === "M"
      if (inspectPathKind(mainPath) !== "file" || inspectPathKind(wtPath) !== "file" || binaryFiles.has(entry.path)) {
        conflictingFiles.push(entry.path);
        continue;
      }
      const oursBuf = readFileSync(mainPath);
      const theirsBuf = readFileSync(wtPath);
      if (oursBuf.includes(0) || theirsBuf.includes(0)) {
        conflictingFiles.push(entry.path);
        continue;
      }
      const baseRes = await runProcess("git", ["show", `${meta.baseCommit}:${entry.path}`], {
        cwd: meta.worktreePath,
        timeoutMs: 20_000,
      });
      if (baseRes.code !== 0 || baseRes.overflowed) {
        conflictingFiles.push(entry.path);
        continue;
      }

      const oursText = oursBuf.toString("utf8");
      const oursHadCrlf = oursText.includes("\r\n");
      const oursTmp = join(mergeDir, `${index}.ours`);
      const baseTmp = join(mergeDir, `${index}.base`);
      const theirsTmp = join(mergeDir, `${index}.theirs`);
      writeFileSync(oursTmp, oursText.replace(/\r\n/g, "\n"), "utf8");
      writeFileSync(baseTmp, baseRes.stdout.replace(/\r\n/g, "\n"), "utf8");
      writeFileSync(theirsTmp, theirsBuf.toString("utf8").replace(/\r\n/g, "\n"), "utf8");

      const merged = await runProcess("git", ["merge-file", "-p", oursTmp, baseTmp, theirsTmp], {
        cwd: mergeDir,
        timeoutMs: 20_000,
      });
      if (merged.code === 0 && !merged.overflowed) {
        const normalized = merged.stdout.replace(/\r\n/g, "\n");
        const finalText = oursHadCrlf ? normalized.replace(/\n/g, "\r\n") : normalized;
        plannedOps.push({ kind: "write", path: mainPath, content: Buffer.from(finalText, "utf8") });
      } else {
        conflictingFiles.push(entry.path);
      }
    }

    if (conflictingFiles.length > 0) {
      return { ok: false, conflictingFiles };
    }

    const backups: Array<{ readonly path: string; readonly existed: boolean; readonly content?: Buffer }> = [];
    const seenPaths = new Set<string>();
    try {
      for (const op of plannedOps) {
        const existed = existsSync(op.path);
        if (!seenPaths.has(op.path)) {
          seenPaths.add(op.path);
          backups.push(
            existed
              ? { path: op.path, existed: true, content: readFileSync(op.path) }
              : { path: op.path, existed: false },
          );
        }
        if (op.kind === "write") {
          ensureDir(dirname(op.path));
          writeFileSync(op.path, op.content);
        } else if (existed) {
          rmSync(op.path, { force: true });
        }
      }
      return { ok: true };
    } catch (error) {
      for (let i = backups.length - 1; i >= 0; i -= 1) {
        const backup = backups[i]!;
        try {
          if (backup.existed && backup.content !== undefined) {
            ensureDir(dirname(backup.path));
            writeFileSync(backup.path, backup.content);
          } else {
            rmSync(backup.path, { force: true });
          }
        } catch {
          /* 尽力回滚 */
        }
      }
      return {
        ok: false,
        conflictingFiles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    rmSync(mergeDir, { recursive: true, force: true });
  }
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
      const threeWay = await tryThreeWayMerge(meta, snapshot.commitRef);
      if (threeWay.ok) {
        if (options.removeOnSuccess !== false) {
          await cleanupWorktreeDirAndBranch(meta);
        }
        const msg = `已通过三方合并自动合入 ${snapshot.files.length} 个文件`;
        writeWorktreeMeta(worktreesDir, {
          ...meta,
          state: "merged",
          files: snapshot.files,
          message: msg,
        });
        return { applied: true, files: snapshot.files, message: msg };
      }

      const detail = (threeWay.error || check.stderr || check.stdout).trim().slice(0, 400);
      const conflictHint =
        threeWay.conflictingFiles.length > 0
          ? `（冲突文件：${threeWay.conflictingFiles.join(", ")}）`
          : "";
      const msg = `与主工作区存在冲突${conflictHint}，已保留隔离工作区（分支 ${meta.branch}）：${detail || "git apply 与三方合并均检测到冲突"}`;
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

function isValidWorktreeMeta(value: unknown): value is WorktreeMeta {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["taskId"] === "string" &&
    typeof record["workspaceId"] === "string" &&
    typeof record["workspaceRoot"] === "string" &&
    typeof record["worktreePath"] === "string" &&
    typeof record["branch"] === "string" &&
    typeof record["state"] === "string"
  );
}

function listWorktreeMetas(
  worktreesDir: string,
  workspaceId?: string,
): Array<{ readonly metaFile: string; readonly meta: WorktreeMeta }> {
  if (!existsSync(worktreesDir)) return [];
  const wsDirs: string[] = [];
  if (workspaceId !== undefined) {
    if (!isSafeId(workspaceId)) return [];
    const target = join(worktreesDir, workspaceId);
    if (existsSync(target)) wsDirs.push(target);
  } else {
    try {
      for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
        if (entry.isDirectory() && isSafeId(entry.name)) {
          wsDirs.push(join(worktreesDir, entry.name));
        }
      }
    } catch {
      return [];
    }
  }

  const out: Array<{ readonly metaFile: string; readonly meta: WorktreeMeta }> = [];
  for (const dir of wsDirs) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".meta.json")) continue;
        const metaFile = join(dir, entry.name);
        try {
          const parsed: unknown = JSON.parse(readFileSync(metaFile, "utf8"));
          if (isValidWorktreeMeta(parsed)) {
            out.push({ metaFile, meta: parsed });
          }
        } catch {
          /* 忽略损坏的 meta 文件 */
        }
      }
    } catch {
      /* 忽略不可读工作区目录 */
    }
  }
  return out;
}

/** 启动自愈：将崩溃遗留的 `active` 状态隔离工作区收敛为 `kept`（目录仍在）或 `discarded`（目录已删）。 */
export async function recoverOrphanedWorktrees(
  worktreesDir: string,
  options?: { readonly activeTaskIds?: ReadonlySet<string> },
): Promise<{ readonly recovered: number; readonly discarded: number }> {
  let recovered = 0;
  let discarded = 0;
  for (const { meta } of listWorktreeMetas(worktreesDir)) {
    if (meta.state !== "active") continue;
    if (options?.activeTaskIds?.has(meta.taskId) === true) continue;
    if (existsSync(meta.worktreePath)) {
      const committed = await commitWorktreeChanges(meta).catch(() => null);
      const files =
        committed !== null && committed.ok ? committed.value.files : [...(meta.files ?? [])];
      writeWorktreeMeta(worktreesDir, {
        ...meta,
        state: "kept",
        files,
        message: "宿主重启时发现中断的隔离工作区，已保留现场供审阅、合入或丢弃。",
      });
      recovered += 1;
    } else {
      if (existsSync(meta.workspaceRoot)) {
        await cleanupWorktreeDirAndBranch(meta).catch(() => undefined);
      }
      writeWorktreeMeta(worktreesDir, {
        ...meta,
        state: "discarded",
        message: "宿主重启时发现隔离工作区目录已不存在，已自动标记为丢弃。",
      });
      discarded += 1;
    }
  }
  return { recovered, discarded };
}

/** 清理已结束（或开启 `includeKept` 时的遗留保留）worktree 目录、临时分支与元数据记录。 */
export async function pruneFinishedWorktrees(
  worktreesDir: string,
  options?: { readonly workspaceId?: string; readonly includeKept?: boolean },
): Promise<{ readonly removed: number }> {
  let removed = 0;
  const prunedRoots = new Set<string>();
  const includeKept = options?.includeKept === true;
  for (const { metaFile, meta } of listWorktreeMetas(worktreesDir, options?.workspaceId)) {
    if (meta.state === "active") continue;
    const isFinished = meta.state === "merged" || meta.state === "discarded";
    const isKeptOrConflict = meta.state === "kept" || meta.state === "conflict";
    if (!isFinished && !(includeKept && isKeptOrConflict)) continue;

    if (
      existsSync(meta.workspaceRoot) &&
      (existsSync(meta.worktreePath) || isKeptOrConflict)
    ) {
      await cleanupWorktreeDirAndBranch(meta).catch(() => undefined);
      prunedRoots.add(meta.workspaceRoot);
    }
    try {
      rmSync(metaFile, { force: true });
      removed += 1;
    } catch {
      /* 忽略删除元数据失败 */
    }
  }

  for (const root of prunedRoots) {
    if (!existsSync(root)) continue;
    await runProcess("git", ["worktree", "prune"], { cwd: root, timeoutMs: 15_000 }).catch(() => undefined);
  }
  return { removed };
}
