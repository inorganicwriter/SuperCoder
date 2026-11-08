/**
 * 会话事件的唯一定义。遵循架构设计规范。
 *
 * zod 是唯一源：类型由 `z.infer` 推导，字段清单由 schema 键推导。
 * 改这里的字段名等于改盘上格式——加载守卫会拒绝旧日志，所以只在不兼容升级时动它。
 */

import { z } from "zod";
import { DelegationEventSchema, DelegationResultSchema } from "../domain/delegation.js";
import { ToolOutcomeSchema } from "../domain/tool.js";

const S = { seq: z.number().int().positive(), at: z.string() };

/** 会话状态，可派生：idle / running / awaiting / unknown。 */
export const SessionStatusSchema = z.enum(["idle", "running", "awaiting", "unknown"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * 日志首行携带的会话元数据。
 *
 * 为什么要放在首行：`session.rename` 之后即使删光 `index.json`，
 * 基础元数据（标题、工作区、语言）通过首行 header 持久化以支持无缓存恢复。
 */
export const SessionMetaSchema = z.object({
  title: z.string(),
  createdAt: z.string(),
  workspace: z.string(),
  language: z.string(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const LOG_HEADER_KIND = "header";

/** 首行：`{"kind":"header","fields":"<shapeOf()>","meta":{...}}`。 */
export const LogHeaderSchema = z.object({
  kind: z.literal(LOG_HEADER_KIND),
  fields: z.string(),
  meta: SessionMetaSchema,
});
export type LogHeader = z.infer<typeof LogHeaderSchema>;

export const META_FIELDS = "title,createdAt,workspace,language";

export const EVENT = {
  "user/message": z.object({ ...S, text: z.string(), attachments: z.array(z.string()) }),
  "user/rewind": z.object({ ...S, toSeq: z.number().int().nonnegative() }),

  "request/header": z.object({
    ...S,
    step: z.number().int().nonnegative(),
    provider: z.string(),
    model: z.string(),
    system: z.string(),
    toolNames: z.array(z.string()),
  }),
  "request/delta": z.object({ ...S, step: z.number().int().nonnegative(), text: z.string() }),
  "assistant/message": z.object({
    ...S,
    step: z.number().int().nonnegative(),
    text: z.string(),
    usage: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
      })
      .optional(),
  }),
  "assistant/attempt": z.object({
    ...S,
    step: z.number().int().nonnegative(),
    reason: z.string(),
    partial: z.string().optional(),
  }),

  "tool/call": z.object({
    ...S,
    callId: z.string(),
    name: z.string(),
    args: z.unknown(),
  }),
  "tool/approval-requested": z.object({ ...S, callId: z.string() }),
  "tool/decision": z.object({
    ...S,
    callId: z.string(),
    decision: z.enum(["allow", "deny"]),
    remember: z.enum(["none", "turn", "workspace"]),
    reason: z.string().optional(),
  }),
  "tool/result": z.object({ ...S, callId: z.string(), outcome: ToolOutcomeSchema }),

  "delegation/spawn": z.object({
    ...S,
    childId: z.string(),
    provider: z.string(),
    agentId: z.string(),
    instruction: z.string(),
    goal: z.string(),
    resumeSessionId: z.string().optional(),
    /** 只读 / 可写。派生任务视图要用，缺省按只读处理。 */
    mode: z.enum(["read-only", "write"]).optional(),
  }),
  "delegation/delivery": z.object({
    ...S,
    childId: z.string(),
    state: z.enum(["queued", "submitted", "received", "returned"]),
  }),
  "delegation/progress": z.object({ ...S, childId: z.string(), event: DelegationEventSchema }),
  "delegation/result": z.object({
    ...S,
    childId: z.string(),
    result: DelegationResultSchema,
  }),

  "capsule/saved": z.object({
    ...S,
    capsuleId: z.string(),
    /** remove：从共享上下文里移除（日志保留记录，派生时不再出现）。 */
    action: z.enum(["create", "update", "promote", "remove"]),
    title: z.string(),
    humanSummary: z.string(),
    technicalHandoff: z.string(),
    touchedFiles: z.array(z.string()),
    scope: z.enum(["chat", "workspace"]),
  }),
  "question/asked": z.object({
    ...S,
    questionId: z.string(),
    question: z.string(),
    options: z.array(z.string()),
  }),
  "question/answered": z.object({
    ...S,
    questionId: z.string(),
    answer: z.string(),
  }),

  "snapshot/taken": z.object({
    ...S,
    taskId: z.string(),
    files: z.array(
      z.object({
        path: z.string(),
        mtimeMs: z.number(),
        size: z.number(),
      }),
    ),
  }),
  "rewind/completed": z.object({
    ...S,
    toSeq: z.number().int().nonnegative(),
    restoredFiles: z.array(z.string()),
  }),

  "turn/start": z.object({ ...S, chatId: z.string() }),
  "turn/end": z.object({
    ...S,
    status: z.enum(["completed", "interrupted", "unknown"]),
    reason: z.string().optional(),
  }),

  "session/repaired": z.object({
    ...S,
    truncatedBytes: z.number().int().nonnegative(),
  }),

  /**
   * 上下文压缩：seq ≤ throughSeq 的对话已被概括成 text。
   * 只影响喂给模型的上下文；原始事件一条不删，回看与回撤不受影响。
   */
  "context/summary": z.object({
    ...S,
    throughSeq: z.number().int().nonnegative(),
    text: z.string(),
  }),
} as const;

export type EventType = keyof typeof EVENT;
export type EventPayload<K extends EventType> = z.infer<(typeof EVENT)[K]>;
/**
 * 瞬态事件：只走增量推送，不落盘、不占 seq（借下一次写入的序号，见 、）。
 * 因此按 seq 去重时必须把它们排除在外——同一个 seq 会出现在它们和真正落盘的那条上。
 */
export const TRANSIENT_EVENT_TYPES = ["request/delta"] as const;

export type TransientEventType = (typeof TRANSIENT_EVENT_TYPES)[number];

export function isTransientEvent(type: string): boolean {
  return (TRANSIENT_EVENT_TYPES as readonly string[]).includes(type);
}

export type SessionEvent = { [K in EventType]: { type: K } & EventPayload<K> }[EventType];

/** 某类事件允许的字段，按 schema 声明顺序。 */
export function eventFields(type: EventType): string[] {
  return Object.keys(EVENT[type].shape);
}

export const EVENT_TYPES = Object.keys(EVENT) as EventType[];

export function isEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(EVENT, value);
}

export type EventParse =
  | { readonly ok: true; readonly value: SessionEvent }
  | { readonly ok: false; readonly issue: string };

/**
 * 逐行校验入口。失败时返回可直接展示的原因，由调用方加上行号。
 */
export function parseSessionEvent(input: unknown): EventParse {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, issue: "事件不是对象" };
  }
  const type = (input as { type?: unknown }).type;
  if (typeof type !== "string" || !isEventType(type)) {
    return { ok: false, issue: `未知事件类型 ${JSON.stringify(type ?? null)}` };
  }
  const parsed = EVENT[type].safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, issue: issues };
  }
  return { ok: true, value: { ...parsed.data, type } as SessionEvent };
}

/** 供帧校验复用：类型是 `SessionEvent`，运行时仍走 `parseSessionEvent`。 */
export const SessionEventSchema = z.custom<SessionEvent>(
  (value) => parseSessionEvent(value).ok,
  { message: "事件数据结构不符合契约规范" },
);
