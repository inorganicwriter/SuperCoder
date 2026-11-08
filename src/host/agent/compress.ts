/**
 * 上下文压缩：用到窗口的 80% 时，把较早的对话交给当前模型概括成一段摘要。
 *
 * - 摘要写成 context/summary 事件：原始事件一条不删，回看、回撤、核实都不受影响；
 * - 最近两条用户消息及其后的内容原样保留，模型对眼前的事不丢细节；
 * - 已有摘要时连同旧摘要一起再概括，摘要不会越叠越长；
 * - 概括失败就不压缩（退回到按条数截断的老办法），不让一轮对话因此失败。
 */

import type { SessionEvent } from "../../shared/session/events.js";
import type { ChatMessage, LlmClient } from "../models/llm.js";
import { activeSummary, buildTurnContext } from "./context.js";

// 当前主流模型的上下文窗口是 1M；档案里填了 contextWindow 就以档案为准。
export const DEFAULT_CONTEXT_TOKENS = 1_000_000;
export const COMPRESS_AT = 0.8;
/** 原样保留的最近用户消息条数（连同它们之后的全部内容）。 */
const KEEP_USER_TURNS = 2;
/** 交给模型概括的转写稿上限：太长的工具输出先截短，摘要只需要结论。 */
const MAX_TRANSCRIPT_CHARS = 400_000;
const MAX_ITEM_CHARS = 4_000;

/**
 * 粗估 token：CJK 字符按 1 个、其余按 4 个字符 1 个。
 * 估算 token 占用以判断是否接近窗口阈值，采用略偏保守的上限估算法。
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    const text = message.content + (message.toolCalls?.map((call) => call.name + call.arguments).join("") ?? "");
    const cjk = text.match(/[　-鿿가-힯＀-￯]/g)?.length ?? 0;
    tokens += cjk + Math.ceil((text.length - cjk) / 4) + 4;
  }
  return tokens;
}

/**
 * 压缩的切点：倒数第 KEEP_USER_TURNS 条用户消息之前的最后一个 seq。
 * 切点必须比现有摘要覆盖得更远，否则压缩没有意义，返回 null。
 */
export function compressionCut(
  events: readonly SessionEvent[],
  rewind: { readonly toSeq: number; readonly seq: number } | null,
): number | null {
  const inWindow = (seq: number): boolean => rewind === null || seq <= rewind.toSeq || seq > rewind.seq;
  const users = events.filter((event) => event.type === "user/message" && inWindow(event.seq));
  const keepFrom = users[users.length - KEEP_USER_TURNS];
  if (keepFrom === undefined) return null;
  const cut = keepFrom.seq - 1;
  const current = activeSummary(events, rewind);
  if (cut <= (current?.throughSeq ?? 0)) return null;
  return cut;
}

/** 把要概括的那一段（含旧摘要）写成纯文本转写稿。 */
export function transcriptFor(
  events: readonly SessionEvent[],
  rewind: { readonly toSeq: number; readonly seq: number } | null,
  cut: number,
): string {
  const messages = buildTurnContext({
    events: events.filter((event) => event.seq <= cut),
    system: "",
    rewind,
    maxMessages: Number.MAX_SAFE_INTEGER,
  });
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system" && message.content === "") continue;
    const calls = message.toolCalls?.map((call) => `${call.name}(${call.arguments})`).join("; ");
    const body = calls !== undefined && calls !== "" ? `[calls ${calls}] ${message.content}` : message.content;
    const clipped = body.length > MAX_ITEM_CHARS ? `${body.slice(0, MAX_ITEM_CHARS)}…（已截短）` : body;
    lines.push(`${message.role}: ${clipped}`);
  }
  const text = lines.join("\n\n");
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(text.length - MAX_TRANSCRIPT_CHARS) : text;
}

const SUMMARY_INSTRUCTION = [
  "Summarize the conversation below so it can replace the original in later turns.",
  "Keep: the user's goals, decisions and preferences; which agents were used, their task IDs and outcomes; files and paths that matter; open questions and next steps.",
  "Drop: greetings, repeated content, raw tool output already reflected in conclusions.",
  "Write in the user's language, as compact bullet points. Do not invent anything.",
].join("\n");

/** 用当前模型写摘要。失败或为空时返回 null，由调用方决定退回老办法。 */
export async function summarize(client: LlmClient, transcript: string, signal: AbortSignal): Promise<string | null> {
  const messages: ChatMessage[] = [
    { role: "system", content: SUMMARY_INSTRUCTION },
    { role: "user", content: transcript },
  ];
  let text = "";
  try {
    for await (const chunk of client.stream({ messages, tools: [], signal })) {
      if (signal.aborted) return null;
      if (chunk.type === "text") text += chunk.text;
      if (chunk.type === "error") return null;
    }
  } catch {
    return null;
  }
  return text.trim() === "" ? null : text.trim();
}
