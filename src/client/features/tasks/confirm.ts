/**
 * 任务面板里「已确认副作用」的状态。遵循架构设计规范。
 *
 * 确认是按任务计的：unknown 任务的 `confirmSideEffects` 只由它自己的勾选框决定，
 * 勾一个不能顺手授权另一个（那些任务可能已经改过工作区）。
 * 这里只放纯函数，React 只负责调用它们。
 */

/** 已确认副作用的任务 id 集合。 */
export type ConfirmedTasks = ReadonlySet<string>;

export const EMPTY_CONFIRMED: ConfirmedTasks = new Set<string>();

export function isConfirmed(confirmed: ConfirmedTasks, taskId: string): boolean {
  return confirmed.has(taskId);
}

/** 返回新集合：勾选就加入，取消就移除。不改传入的集合。 */
export function toggleConfirmed(
  confirmed: ConfirmedTasks,
  taskId: string,
  checked: boolean,
): ConfirmedTasks {
  const next = new Set(confirmed);
  if (checked) next.add(taskId);
  else next.delete(taskId);
  return next;
}
