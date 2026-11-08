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

import { statSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "../../shared/session/events.js";

export interface SnapshotFile {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
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
