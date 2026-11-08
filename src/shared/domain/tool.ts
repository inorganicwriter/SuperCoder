/**
 * 工具执行结果。遵循架构设计规范。
 *
 * 三个分支的语义边界：
 * - ok / error：确定没有留下副作用，或确定失败
 * - uncertain：可能有副作用，结果未知。调用方必须停下等人工确认
 */

import { z } from "zod";

export const ToolOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    value: z.unknown(),
  }),
  z.object({
    status: z.literal("error"),
    code: z.enum(["invalid_args", "denied", "timeout", "failed", "unknown_tool"]),
    message: z.string(),
    retryable: z.boolean(),
  }),
  z.object({
    status: z.literal("uncertain"),
    code: z.literal("execution_state_unknown"),
    detail: z.string(),
  }),
]);

export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;

/** 可能已产生副作用的失败。调用方据此决定是否等待人工确认。 */
export function isUncertain(outcome: ToolOutcome): boolean {
  return outcome.status === "uncertain";
}
