/**
 * 回撤要动哪些文件。遵循架构设计规范。
 *
 * 快照记的是"任务分派之前工作区长什么样"（path + mtimeMs + size）。回撤时只把
 * **现在的状态与快照不同**的文件交给 `git checkout --`：
 * - 快照之后没动过的文件不碰（同一份内容，恢复它只会扩大影响面）
 * - 被改过、被删掉的文件才恢复
 * - 已知边界：快照只记 mtime + size，同一毫秒内被改成同样大小的文件分辨不出来
 *   （真要精确到字节得记内容哈希，那会改掉  的事件形状，此处不做）
 * 工作区不是 git 仓库时，调用方必须中止回撤并让用户决定（不猜文件内容）。
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { SessionEvent } from "../../shared/session/events.js";
import { diffSnapshots, snapshotWorkspace } from "./snapshot.js";

export interface SnapshotFile {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export interface RewindPlan {
  readonly candidates: string[];
  readonly addedSinceSnapshot: string[];
  readonly earliestTaskId: string | null;
}

/** 只挑"和快照不一样"的文件；`toSeq` 及之前的事件不算（那段是要保留的历史）。 */
export function collectRewindCandidates(
  events: readonly SessionEvent[],
  toSeq: number,
  root: string,
): string[] {
  const changed = new Set<string>();
  for (const event of events) {
    if (event.type !== "snapshot/taken") continue;
    if (event.seq <= toSeq) continue;
    for (const file of event.files as readonly SnapshotFile[]) {
      if (file.path === "") continue;
      if (changed.has(file.path)) continue;
      if (differsFromSnapshot(root, file)) changed.add(file.path);
    }
  }
  return [...changed];
}

/**
 * 规划回撤范围：既包含快照前已存在且后来发生变更/删除的文件，
 * 也包含任务开始后新增的文件，并定位最早一条回撤快照关联的任务（用于取回 Git 基线）。
 */
export function collectRewindPlan(
  events: readonly SessionEvent[],
  toSeq: number,
  root: string,
): RewindPlan {
  const candidates = collectRewindCandidates(events, toSeq, root);
  let earliest: { readonly taskId: string; readonly files: readonly SnapshotFile[] } | null = null;
  for (const event of events) {
    if (event.type !== "snapshot/taken" || event.seq <= toSeq) continue;
    earliest = { taskId: event.taskId, files: event.files as readonly SnapshotFile[] };
    break;
  }
  let addedSinceSnapshot: string[] = [];
  if (earliest !== null) {
    try {
      const current = snapshotWorkspace(root);
      addedSinceSnapshot = [...diffSnapshots(earliest.files, current.files).added];
    } catch {
      addedSinceSnapshot = [];
    }
  }
  return {
    candidates,
    addedSinceSnapshot,
    earliestTaskId: earliest?.taskId ?? null,
  };
}

/** 安全删除回撤区间内新建的未跟踪文件（严格限定在工作区根之内，跳过 .git）。 */
export function removeAddedFiles(root: string, paths: readonly string[]): string[] {
  const resolvedRoot = resolve(root);
  const removed: string[] = [];
  for (const rel of paths) {
    if (rel === "" || rel === ".git" || rel.startsWith(".git/") || rel.startsWith(".git\\")) continue;
    const full = resolve(resolvedRoot, rel);
    if (!full.startsWith(resolvedRoot + sep)) continue;
    try {
      if (existsSync(full) && statSync(full).isFile()) {
        rmSync(full, { force: true });
        removed.push(rel);
      }
    } catch {
      // 删除单个文件失败时继续清理其余文件
    }
  }
  return removed;
}

function differsFromSnapshot(root: string, file: SnapshotFile): boolean {
  try {
    const current = statSync(join(root, file.path));
    // 不用容差：多恢复一个没变的文件只是空操作，漏掉一个改过的文件是真丢东西。
    return current.size !== file.size || current.mtimeMs !== file.mtimeMs;
  } catch {
    // 文件不在了：也算"被动过"，交给 git 恢复。
    return true;
  }
}
