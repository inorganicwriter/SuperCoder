/**
 * 上下文重建。遵循架构设计规范。
 *
 * 对话上下文由会话事件日志动态投影生成，不维护独立的持久化历史副本。
 * 倒带（`user/rewind`）之后只喂窗口内的事件，所以模型看不到被丢弃的中间段。
 */

import type { ChatMessage, ToolCallRequest } from "../models/llm.js";
import type { SessionEvent } from "../../shared/session/events.js";

// 长度主要由按 token 计的压缩控制（见 compress.ts）；条数上限只是极端情况下的兜底。
export const MAX_CONTEXT_MESSAGES = 1000;
const MAX_TOOL_TEXT = 8_000;

export interface ContextInput {
  readonly events: readonly SessionEvent[];
  readonly system: string;
  readonly rewind: { readonly toSeq: number; readonly seq: number } | null;
  readonly maxMessages?: number;
  /** 本工作区其它对话里保存的共享上下文（胶囊），放在系统提示之后。 */
  readonly shared?: string;
}

/**
 * 当前生效的压缩摘要：窗口内最新的一条 context/summary。
 * 回撤到摘要覆盖范围之内时，摘要失效（它概括的内容里有被回撤掉的部分）。
 */
export function activeSummary(
  events: readonly SessionEvent[],
  rewind: { readonly toSeq: number; readonly seq: number } | null,
): { readonly seq: number; readonly throughSeq: number; readonly text: string } | null {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event?.type !== "context/summary" || !inRewindWindow(event.seq, rewind)) continue;
    if (rewind !== null && event.seq <= rewind.seq && event.throughSeq > rewind.toSeq) continue;
    return { seq: event.seq, throughSeq: event.throughSeq, text: event.text };
  }
  return null;
}

/** 倒带窗口：`seq ≤ toSeq` 或 `seq > rewindSeq`。中间段留在盘上但不进上下文。 */
export function inRewindWindow(
  seq: number,
  rewind: { readonly toSeq: number; readonly seq: number } | null,
): boolean {
  if (rewind === null) return true;
  return seq <= rewind.toSeq || seq > rewind.seq;
}

export function buildTurnContext(input: ContextInput): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const pendingCalls = new Map<string, ToolCallRequest>();
  let dropped = 0;
  const summary = activeSummary(input.events, input.rewind);

  for (const event of input.events) {
    if (!inRewindWindow(event.seq, input.rewind)) continue;
    // 已被摘要概括的部分不再逐条喂给模型。
    if (summary !== null && event.seq <= summary.throughSeq) continue;
    switch (event.type) {
      case "user/message":
        flushCalls(messages, pendingCalls);
        messages.push({ role: "user", content: event.text });
        break;
      case "assistant/message":
        flushCalls(messages, pendingCalls);
        messages.push({ role: "assistant", content: event.text });
        break;
      case "tool/call":
        pendingCalls.set(event.callId, {
          id: event.callId,
          name: event.name,
          arguments: JSON.stringify(event.args ?? {}),
        });
        break;
      case "tool/result": {
        const call = pendingCalls.get(event.callId);
        if (call === undefined) break;
        pendingCalls.delete(event.callId);
        messages.push({ role: "assistant", content: "", toolCalls: [call] });
        messages.push({
          role: "tool",
          content: renderOutcome(event.outcome),
          toolCallId: call.id,
        });
        break;
      }
      default:
        break;
    }
  }
  flushCalls(messages, pendingCalls);

  const limit = input.maxMessages ?? MAX_CONTEXT_MESSAGES;
  let body = messages;
  if (body.length > limit) {
    dropped = body.length - limit;
    body = body.slice(-limit);
  }

  const head: ChatMessage[] = [{ role: "system", content: input.system }];
  if (input.shared !== undefined && input.shared.trim() !== "") {
    head.push({ role: "system", content: `Shared context saved in earlier chats of this workspace:
${input.shared}` });
  }
  if (summary !== null) {
    head.push({ role: "system", content: `Summary of the earlier part of this conversation:
${summary.text}` });
  }
  if (dropped > 0) {
    head.push({
      role: "system",
      content: `（早前 ${dropped} 条消息因为超出上下文上限被省略；需要时用工具重新查证。）`,
    });
  }
  return [...head, ...body];
}

function flushCalls(messages: ChatMessage[], pending: Map<string, ToolCallRequest>): void {
  // 没有结果的调用（进程崩过）不能凭空补结果：留一条说明，模型就不会以为工具跑完了。
  for (const call of pending.values()) {
    messages.push({ role: "assistant", content: "", toolCalls: [call] });
    messages.push({
      role: "tool",
      content: "（这次调用没有结果记录：当时进程可能异常退出。不要假设它成功了。）",
      toolCallId: call.id,
    });
  }
  pending.clear();
}

function renderOutcome(outcome: { status: string } & Record<string, unknown>): string {
  const text = JSON.stringify(outcome);
  if (text.length <= MAX_TOOL_TEXT) return text;
  // 明确标注截断：模型必须知道这不是完整结果。
  return `${text.slice(0, MAX_TOOL_TEXT)}\n…（结果过长，已截断；需要细节请用更小的范围再查一次）`;
}
