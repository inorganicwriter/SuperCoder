/**
 * 实体从事件派生。遵循架构设计规范。
 *
 * 一张表定死来源：
 * - 消息      ← `user/message`、`assistant/message`
 * - 工具调用  ← `tool/call` → `tool/decision` → `tool/result`
 * - 任务      ← `delegation/spawn` → `delegation/delivery` → `delegation/result`
 * - 胶囊      ← `capsule/saved`（无状态机，取最后一次）
 * - 待办      ← 未答复的提问、等审批的工具、unknown 的任务（驻内存派生）
 *
 * 这里只做投影，不写盘、不联网。host 与 client 共用同一份实现，
 * 统一状态机逻辑，确保界面渲染与底层日志事件投影结果完全一致。
 */

import { z } from "zod";
import type { Capsule } from "../domain/capsule.js";
import type { ReceiptState } from "../domain/provider.js";
import type { TaskState, TaskView } from "../domain/task.js";
import type { ToolOutcome } from "../domain/tool.js";
import {
  isTransientEvent,
  SessionStatusSchema,
  type SessionEvent,
  type SessionStatus,
} from "./events.js";

export interface MessageView {
  readonly seq: number;
  readonly at: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments: readonly string[];
  /** assistant 消息所属的 step；用户消息为 null。 */
  readonly step: number | null;
}

export type ToolCallState =
  | "pending"
  | "awaiting-approval"
  | "running"
  | "ok"
  | "error"
  | "uncertain";

export interface ToolCallView {
  readonly callId: string;
  readonly seq: number;
  readonly name: string;
  readonly args: unknown;
  readonly state: ToolCallState;
  readonly outcome: ToolOutcome | null;
}

export interface QuestionView {
  readonly questionId: string;
  readonly seq: number;
  readonly question: string;
  readonly options: readonly string[];
  readonly answer: string | null;
  /** 提问所在的回合已经结束（被打断或进程退出）而没有得到回答：不再等待，留在原位置。 */
  readonly expired: boolean;
}

export type InboxKind = "approval" | "question" | "task-unknown";

export interface InboxItem {
  readonly kind: InboxKind;
  readonly id: string;
  readonly at: string;
  readonly title: string;
}

export interface DerivedView {
  readonly sessionId: string;
  readonly lastSeq: number;
  readonly status: SessionStatus;
  readonly messages: readonly MessageView[];
  readonly tools: readonly ToolCallView[];
  readonly tasks: readonly TaskView[];
  readonly capsules: readonly Capsule[];
  readonly questions: readonly QuestionView[];
  readonly pending: readonly InboxItem[];
  readonly counts: { readonly user: number; readonly assistant: number; readonly tool: number };
  readonly rewind: { readonly toSeq: number; readonly seq: number } | null;
  /**
   * 正在流式生成的助手文本（`request/delta` 累积）。
   *
   * 瞬态事件不落盘、不占 seq，所以它不属于 `messages`；同一 step 的
   * `assistant/message` 到达后清空，界面改为显示那条正式消息。
   */
  readonly streaming: { readonly step: number; readonly text: string } | null;
}

export const SessionCountsSchema = z.object({
  user: z.number().int().nonnegative(),
  assistant: z.number().int().nonnegative(),
  tool: z.number().int().nonnegative(),
});
export type SessionCounts = z.infer<typeof SessionCountsSchema>;

/** `session.list` 的返回项：首行元数据 + 派生状态。 */
export const SessionSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  workspace: z.string(),
  language: z.string(),
  status: SessionStatusSchema,
  lastSeq: z.number().int().nonnegative(),
  counts: SessionCountsSchema,
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export interface DeriveContext {
  readonly sessionId: string;
  readonly workspaceId: string;
}

const DELIVERY_TO_TASK_STATE: Record<ReceiptState, TaskState> = {
  queued: "queued",
  submitted: "submitted",
  received: "received",
  returned: "returned",
};

/**
 * 增量投影器：`apply(event)` 累积，`view()` 给出只读快照。
 *
 * 只向前追加，不回头改历史：`user/rewind` 到来时按  的区间规则裁掉消息，
 * 之后到达的事件 seq 必然大于 rewind 的 seq，自然续在后面。
 *
 * `lastSeq` 的含义是**最后一条已落盘事件的序号**：瞬态事件（`request/delta`，
 * 借"下一条落盘事件的序号"、不落盘）不推进它，否则视图会声称自己见过一条其实不存在的记录。
 */
export class SessionDerivation {
  private readonly messages: MessageView[] = [];
  private readonly tools = new Map<string, ToolCallView>();
  private readonly tasks = new Map<string, TaskView>();
  private readonly capsules = new Map<string, Capsule>();
  private readonly questions = new Map<string, QuestionView>();
  private counts: SessionCounts = { user: 0, assistant: 0, tool: 0 };
  private lastSeq = 0;
  private lastAt = "";
  private turnOpen = false;
  private turnUnknownStatus = false;
  private rewind: { toSeq: number; seq: number } | null = null;
  private streaming: { step: number; text: string } | null = null;

  constructor(private readonly ctx: DeriveContext) {}

  get lastAppliedSeq(): number {
    return this.lastSeq;
  }

  apply(event: SessionEvent): void {
    if (!isTransientEvent(event.type)) this.lastSeq = Math.max(this.lastSeq, event.seq);
    this.lastAt = event.at;
    switch (event.type) {
      case "user/message": {
        this.counts = { ...this.counts, user: this.counts.user + 1 };
        this.messages.push({
          seq: event.seq,
          at: event.at,
          role: "user",
          text: event.text,
          attachments: event.attachments,
          step: null,
        });
        break;
      }
      case "assistant/message": {
        if (this.streaming !== null && this.streaming.step === event.step) this.streaming = null;
        this.counts = { ...this.counts, assistant: this.counts.assistant + 1 };
        this.messages.push({
          seq: event.seq,
          at: event.at,
          role: "assistant",
          text: event.text,
          attachments: [],
          step: event.step,
        });
        break;
      }
      case "user/rewind": {
        this.rewind = { toSeq: event.toSeq, seq: event.seq };
        // 中间区间 (toSeq, seq] 仍在日志里，只是不参与渲染。
        const kept = this.messages.filter((m) => m.seq <= event.toSeq);
        this.messages.length = 0;
        this.messages.push(...kept);
        break;
      }
      case "tool/call": {
        this.counts = { ...this.counts, tool: this.counts.tool + 1 };
        this.tools.set(event.callId, {
          callId: event.callId,
          seq: event.seq,
          name: event.name,
          args: event.args,
          state: "pending",
          outcome: null,
        });
        break;
      }
      case "tool/approval-requested": {
        const tool = this.tools.get(event.callId);
        if (tool) this.tools.set(event.callId, { ...tool, state: "awaiting-approval" });
        break;
      }
      case "tool/decision": {
        const tool = this.tools.get(event.callId);
        if (tool && event.decision === "allow") {
          this.tools.set(event.callId, { ...tool, state: "running" });
        }
        break;
      }
      case "tool/result": {
        const tool = this.tools.get(event.callId);
        const state: ToolCallState =
          event.outcome.status === "ok"
            ? "ok"
            : event.outcome.status === "uncertain"
              ? "uncertain"
              : "error";
        this.tools.set(event.callId, {
          callId: event.callId,
          seq: tool?.seq ?? event.seq,
          name: tool?.name ?? "",
          args: tool?.args ?? null,
          state,
          outcome: event.outcome,
        });
        break;
      }
      case "delegation/spawn": {
        const previous = this.tasks.get(event.childId);
        this.tasks.set(event.childId, {
          taskId: event.childId,
          childId: event.childId,
          providerId: event.provider,
          agentId: event.agentId,
          goal: event.goal,
          instruction: event.instruction,
          mode: event.mode ?? previous?.mode ?? "read-only",
          state: "spawned",
          receipt: null,
          result: null,
          retryCount: previous ? previous.retryCount + 1 : 0,
          createdAt: previous?.createdAt ?? event.at,
          updatedAt: event.at,
          // 在对话里的位置：取这次任务分派（含重试）的 spawn 事件序号。
          seq: event.seq,
        });
        break;
      }
      case "delegation/delivery": {
        const task = this.tasks.get(event.childId);
        if (task) {
          this.tasks.set(event.childId, {
            ...task,
            state: DELIVERY_TO_TASK_STATE[event.state],
            receipt: event.state,
            updatedAt: event.at,
          });
        }
        break;
      }
      case "delegation/progress": {
        const task = this.tasks.get(event.childId);
        if (task) {
          const progress = event.event;
          this.tasks.set(event.childId, {
            ...task,
            ...(progress.type === "session" ? { nativeSessionId: progress.sessionId } : {}),
            ...(progress.type === "trace" && progress.summary.startsWith("model:") ? { selectedModel: progress.summary.slice(6) } : {}),
            ...(progress.type === "trace" && progress.summary.startsWith("model-name:") ? { selectedModelName: progress.summary.slice(11) } : {}),
            ...(progress.type === "trace" && ["general", "plan", "implement", "review", "fix"].some((type) => progress.summary === `task-type:${type}`) ? { taskType: progress.summary.slice(10) as TaskView["taskType"] } : {}),
            ...(progress.type === "trace" && progress.summary.startsWith("provider:") ? { providerId: progress.summary.slice(9) } : {}),
            ...(progress.type === "output" ? { output: (task.output ?? "") + progress.text } : {}),
            updatedAt: event.at,
          });
        }
        break;
      }
      case "delegation/result": {
        const task = this.tasks.get(event.childId);
        const result = event.result;
        const state: TaskState =
          result.status === "ok"
            ? "returned"
            : result.status === "failed"
              ? "failed"
              : result.status === "aborted"
                ? "aborted"
                : "unknown";
        this.tasks.set(event.childId, {
          taskId: event.childId,
          childId: event.childId,
          providerId: task?.providerId ?? "",
          agentId: task?.agentId ?? "",
          goal: task?.goal ?? "",
          instruction: task?.instruction ?? "",
          mode: task?.mode ?? "read-only",
          ...(task?.taskType === undefined ? {} : { taskType: task.taskType }),
          state,
          receipt: task?.receipt ?? null,
          result,
          // 卡片位置沿用 spawn 的 seq：结算事件不带序号，缺了它只能按最大值排序，
          // 卡片会排到对话末尾，而不是留在任务分派的位置。
          seq: task?.seq ?? event.seq,
          ...(task?.nativeSessionId === undefined ? {} : { nativeSessionId: task.nativeSessionId }),
          ...(task?.selectedModel === undefined ? {} : { selectedModel: task.selectedModel }),
          ...(task?.selectedModelName === undefined ? {} : { selectedModelName: task.selectedModelName }),
          ...(task?.output === undefined ? {} : { output: task.output }),
          retryCount: task?.retryCount ?? 0,
          createdAt: task?.createdAt ?? event.at,
          updatedAt: event.at,
        });
        break;
      }
      case "capsule/saved": {
        if (event.action === "remove") {
          this.capsules.delete(event.capsuleId);
          break;
        }
        this.capsules.set(event.capsuleId, {
          capsuleId: event.capsuleId,
          createdAt: this.capsules.get(event.capsuleId)?.createdAt ?? event.at,
          title: event.title,
          humanSummary: event.humanSummary,
          technicalHandoff: event.technicalHandoff,
          touchedFiles: event.touchedFiles,
          scope: event.scope,
          sessionId: this.ctx.sessionId,
          workspaceId: this.ctx.workspaceId,
          updatedAt: event.at,
        });
        break;
      }
      case "question/asked": {
        this.questions.set(event.questionId, {
          questionId: event.questionId,
          seq: event.seq,
          question: event.question,
          options: event.options,
          answer: null,
          expired: false,
        });
        break;
      }
      case "question/answered": {
        const question = this.questions.get(event.questionId);
        if (question) {
          this.questions.set(event.questionId, { ...question, answer: event.answer });
        }
        break;
      }
      case "request/delta": {
        // 同 step 的增量接着拼；换 step 说明是新的一段回答，从头累积。
        const carried = this.streaming?.step === event.step ? this.streaming.text : "";
        this.streaming = { step: event.step, text: carried + event.text };
        break;
      }
      case "turn/start": {
        // 同一会话一次只跑一轮（C4）：新回合开始时还挂着的，只能是上一轮崩溃留下的。
        this.closeOpenItems();
        this.turnOpen = true;
        this.turnUnknownStatus = false;
        // 上一轮异常收尾时可能留下没结清的流式片段，新回合开始就先清掉。
        this.streaming = null;
        break;
      }
      case "turn/end": {
        // 中断也是 turn/end（status = "interrupted"），没有单独的 turn/interrupt 事件。
        this.turnOpen = false;
        this.closeOpenItems();
        this.turnUnknownStatus = event.status === "unknown";
        this.streaming = null;
        break;
      }
      default:
        break;
    }
  }

  /**
   * 回合已经结束，但还有审批或提问挂着（中断时提问没有收尾，或进程在等审批时退出）。
   * 它们再也等不到回应：不收尾的话会一直钉在对话末尾、留在通知里，会话也一直显示"等待中"。
   * - 等审批、尚未执行的工具 → 失败（确定没动过手）
   * - 已在执行或已提交执行的工具 → 结果未知（可能动过手，C7）
   * - 没回答的提问 → 过期，留在原位置
   */
  private closeOpenItems(): void {
    for (const tool of this.tools.values()) {
      if (tool.state === "awaiting-approval") this.tools.set(tool.callId, { ...tool, state: "error" });
      else if (tool.state === "pending" || tool.state === "running") this.tools.set(tool.callId, { ...tool, state: "uncertain" });
    }
    for (const question of this.questions.values()) {
      if (question.answer === null && !question.expired) this.questions.set(question.questionId, { ...question, expired: true });
    }
  }

  get status(): SessionStatus {
    if (this.turnUnknownStatus) return "unknown";
    if (this.tasks.size > 0) {
      for (const task of this.tasks.values()) {
        if (task.state === "unknown") return "unknown";
      }
    }
    for (const tool of this.tools.values()) {
      if (tool.state === "awaiting-approval") return "awaiting";
    }
    for (const question of this.questions.values()) {
      if (question.answer === null && !question.expired) return "awaiting";
    }
    if (this.turnOpen) return "running";
    return "idle";
  }

  view(): DerivedView {
    const pending: InboxItem[] = [];
    for (const tool of this.tools.values()) {
      if (tool.state === "awaiting-approval") {
        pending.push({
          kind: "approval",
          id: tool.callId,
          at: this.lastAt,
          title: tool.name,
        });
      }
    }
    for (const question of this.questions.values()) {
      if (question.answer === null && !question.expired) {
        pending.push({
          kind: "question",
          id: question.questionId,
          at: this.lastAt,
          title: question.question,
        });
      }
    }
    for (const task of this.tasks.values()) {
      if (task.state === "unknown") {
        pending.push({ kind: "task-unknown", id: task.taskId, at: task.updatedAt, title: task.goal });
      }
    }
    return {
      sessionId: this.ctx.sessionId,
      lastSeq: this.lastSeq,
      status: this.status,
      messages: [...this.messages],
      tools: [...this.tools.values()],
      tasks: [...this.tasks.values()],
      capsules: [...this.capsules.values()],
      questions: [...this.questions.values()],
      pending,
      counts: this.counts,
      rewind: this.rewind,
      streaming: this.streaming === null ? null : { ...this.streaming },
    };
  }
}

/** 一次性重算：用于重建索引与测试。 */
export function deriveView(events: readonly SessionEvent[], ctx: DeriveContext): DerivedView {
  const derivation = new SessionDerivation(ctx);
  for (const event of events) derivation.apply(event);
  return derivation.view();
}
