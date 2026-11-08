/**
 * 任务（委派）实体。遵循架构设计规范。
 *
 * 所有字段都是日志投影：`delegation/spawn` → `delegation/delivery` → `delegation/result`。
 * `unknown` 是一等状态：可能已有副作用且无法确认时停在这里，等人工 `task.retry`。
 */

import { z } from "zod";
import { DelegationResultSchema } from "./delegation.js";
import { ReceiptStateSchema } from "./provider.js";

export const TaskStateSchema = z.enum([
  "spawned",
  "queued",
  "submitted",
  "received",
  "returned",
  "failed",
  "aborted",
  "unknown",
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskTypeSchema = z.enum(["general", "plan", "implement", "review", "fix"]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const TaskModeSchema = z.enum(["read-only", "write"]);
export type TaskMode = z.infer<typeof TaskModeSchema>;

export const TaskViewSchema = z.object({
  taskId: z.string(),
  childId: z.string(),
  providerId: z.string(),
  agentId: z.string(),
  goal: z.string(),
  instruction: z.string(),
  mode: TaskModeSchema,
  taskType: TaskTypeSchema.optional(),
  state: TaskStateSchema,
  /** 回执四态里最后一个到达的状态。 */
  receipt: ReceiptStateSchema.nullable(),
  result: DelegationResultSchema.nullable(),
  nativeSessionId: z.string().optional(),
  selectedModel: z.string().optional(),
  selectedModelName: z.string().optional(),
  output: z.string().optional(),
  /** 任务分派（spawn）事件的序号，用来把任务卡片排进对话流。 */
  seq: z.number().int().positive().optional(),
  /** 人工重试次数。`unknown` 态下重试也必须由用户确认后发起。 */
  retryCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TaskView = z.infer<typeof TaskViewSchema>;

/** 终态：不再变化，也不再进"待你处理"。 */
export function isTerminalTaskState(state: TaskState): boolean {
  return state === "returned" || state === "failed" || state === "aborted";
}
