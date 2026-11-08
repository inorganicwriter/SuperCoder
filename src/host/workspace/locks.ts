/**
 * 工作区写锁。遵循并发与数据隔离设计：一个会话一个写入方，一个工作区一个写入型任务。
 *
 * 锁只在本次运行内有效（不落盘）：重启后没人持锁，历史里也没有"锁"这种东西。
 */

import { err, ok, type Result } from "../../shared/result.js";

export interface LockHolder {
  readonly taskId: string;
  readonly acquiredAt: string;
}

export class WorkspaceLocks {
  private readonly held = new Map<string, LockHolder>();

  /** 拿到锁或说明谁拿着。写入型任务必须先拿到它。 */
  acquire(workspaceId: string, taskId: string): Result<LockHolder, string> {
    const current = this.held.get(workspaceId);
    if (current !== undefined) {
      if (current.taskId === taskId) return ok(current);
      return err(
        `当前工作区已有正在执行的写入任务 ${current.taskId}，请等待其执行完成或取消。`,
      );
    }
    const holder: LockHolder = { taskId, acquiredAt: new Date().toISOString() };
    this.held.set(workspaceId, holder);
    return ok(holder);
  }

  release(workspaceId: string, taskId: string): void {
    const current = this.held.get(workspaceId);
    if (current !== undefined && current.taskId === taskId) this.held.delete(workspaceId);
  }

  holder(workspaceId: string): LockHolder | null {
    return this.held.get(workspaceId) ?? null;
  }

  /** 读任务不需要锁：只有写入型任务会占用。 */
  isWriteLocked(workspaceId: string): boolean {
    return this.held.has(workspaceId);
  }

  snapshot(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [workspaceId, holder] of this.held) result[workspaceId] = holder.taskId;
    return result;
  }
}
