/**
 * 工作区快照。遵循架构设计规范 第 2 项（5000 文件 < 300ms）与 。
 *
 * 只 `stat`，不读内容、不算哈希：快照是用来判断"回撤要恢复哪些文件"的，
 * 仅记录文件元数据（mtime 与 size），用于快速变更检测而非全量内容寻址。
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fail } from "../boot/failure.js";

export interface SnapshotFile {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly files: readonly SnapshotFile[];
  readonly takenAt: string;
}

/**
 * 不进入的目录：只跳过版本库内部与依赖目录，它们不属于用户资产。
 *
 * 不要往里加 lib / dist 这类名字：用户工作区里叫 dist 的源码目录很常见
 * （前端产物、Python 包），跳过它们会导致快照漏记文件，影响后续回撤还原的准确性。
 */
const SKIP_DIRS = new Set([".git", "node_modules", ".pnpm-store"]);

/** 相对路径统一用 `/`，写进日志后与平台无关。 */
export function toPosixPath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

export interface SnapshotOptions {
  /** 默认跳过 .git、node_modules 等；测试里可以要求全量。 */
  readonly skipDirs?: ReadonlySet<string>;
  readonly maxFiles?: number;
}

export function snapshotWorkspace(root: string, options: SnapshotOptions = {}): WorkspaceSnapshot {
  const skip = options.skipDirs ?? SKIP_DIRS;
  const maxFiles = options.maxFiles ?? 200_000;
  const files: SnapshotFile[] = [];
  walk(root, root, skip, files, maxFiles);
  // 超过上限就显式失败：少列的文件回撤时不会被还原，而界面看不出来（C6）。
  // 多收一个当探针，正好等于上限是合法的。
  if (files.length > maxFiles) {
    fail(
      "storage_failed",
      `工作区文件总数超过快照上限（${String(maxFiles)}），快照未能完全采集。请将构建产物移出工作区后重试。`,
    );
  }
  return { root, files, takenAt: new Date().toISOString() };
}

function walk(
  root: string,
  dir: string,
  skip: ReadonlySet<string>,
  files: SnapshotFile[],
  maxFiles: number,
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (files.length > maxFiles) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue;
      walk(root, full, skip, files, maxFiles);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = statSync(full);
      files.push({ path: toPosixPath(relative(root, full)), mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // 读不到的条目直接跳过：快照不是审计，缺一个文件不影响回撤。
    }
  }
}

export interface SnapshotDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/** 两次快照的差集：回撤据此决定 `git checkout -- <paths>` 的参数。 */
export function diffSnapshots(
  before: readonly SnapshotFile[],
  after: readonly SnapshotFile[],
): SnapshotDiff {
  const left = new Map(before.map((file) => [file.path, file]));
  const right = new Map(after.map((file) => [file.path, file]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, file] of right) {
    const previous = left.get(path);
    if (previous === undefined) {
      added.push(path);
      continue;
    }
    if (previous.size !== file.size || previous.mtimeMs !== file.mtimeMs) changed.push(path);
  }
  for (const path of left.keys()) {
    if (!right.has(path)) removed.push(path);
  }
  return { added, removed, changed };
}

/** 回撤要恢复的路径：新增的删掉、改过与删掉的取回来。 */
export function pathsToRestore(diff: SnapshotDiff): string[] {
  return [...new Set([...diff.changed, ...diff.removed])].sort();
}
