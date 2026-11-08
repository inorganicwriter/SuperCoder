/**
 * 任务分派与失败分类。遵循架构设计规范。
 *
 * 两个硬约定：
 * - `unknown` 是结果之一，不是异常：进程已死且无法确认对方是否已动手时用它。
 * - `SafeDiagnostic.detail` 只给人看，≤ 200 字符，脱敏后写入，不参与任何判断。
 */

import { z } from "zod";

export const FailureCategorySchema = z.enum([
  "limit",
  "access-policy",
  "auth",
  "service",
  "transport",
  "protocol",
  "invalid-result",
  "process",
  "unknown",
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const DelegationStageSchema = z.enum([
  "detect",
  "spawn",
  "handshake",
  "turn",
  "collect",
]);
export type DelegationStage = z.infer<typeof DelegationStageSchema>;

/** detail 上限 200 字符：超长即截断，因为这里只是给人读的短句。 */
export const SAFE_DETAIL_MAX = 200;

export const SafeDiagnosticSchema = z.object({
  stage: DelegationStageSchema,
  category: FailureCategorySchema,
  exitCode: z.number().int().optional(),
  httpStatus: z.number().int().optional(),
  detail: z.string().max(SAFE_DETAIL_MAX).optional(),
});
export type SafeDiagnostic = z.infer<typeof SafeDiagnosticSchema>;

export const DelegationResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    answer: z.string(),
    sessionId: z.string().optional(),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    status: z.literal("failed"),
    diagnostic: SafeDiagnosticSchema,
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    status: z.literal("aborted"),
    durationMs: z.number().nonnegative(),
  }),
  z.object({
    status: z.literal("unknown"),
    observed: z.string(),
    since: z.string(),
  }),
]);
export type DelegationResult = z.infer<typeof DelegationResultSchema>;

/**  的答案选择只看这些阶段。null 是旧版本兼容位。 */
export const DelegationPhaseSchema = z.enum([
  "detect",
  "spawn",
  "handshake",
  "turn",
  "collect",
]);
export type DelegationPhase = z.infer<typeof DelegationPhaseSchema>;

export const DelegationEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("phase"), phase: DelegationPhaseSchema }),
  z.object({ type: z.literal("trace"), summary: z.string() }),
  z.object({ type: z.literal("output"), text: z.string() }),
  z.object({ type: z.literal("session"), sessionId: z.string() }),
]);
export type DelegationEvent = z.infer<typeof DelegationEventSchema>;

/** 任务分派请求。signal 与 onEvent 是运行时对象，不进 zod。 */
export interface DelegationRequest {
  readonly childId: string;
  readonly agentId: string;
  readonly workspace: string;
  /** 用户原话，原样传给执行者（产品不变量 1）。 */
  readonly goal: string;
  /** 补充要求，可为空。 */
  readonly instruction: string;
  readonly mode: "read-only" | "write";
  readonly taskType?: "general" | "plan" | "implement" | "review" | "fix";
  readonly model?: string;
  /** Runtime-only provider credentials; never serialize into events or diagnostics. */
  readonly modelConfig?: AgentModelConfig;
  readonly effort?: string;
  readonly resumeSessionId?: string;
  readonly signal: AbortSignal;
  readonly onEvent: (e: DelegationEvent) => void;
}

export interface AgentModelConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}
