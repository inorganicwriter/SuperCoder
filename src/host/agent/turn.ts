/**
 * 一个回合。遵循架构设计规范。
 *
 * 顺序：`turn/start` → `user/message` → 循环（`request/header` → 流式 delta → `assistant/message`
 * → 工具调用 → 工具结果）→ `turn/end`。
 *
 * 硬规则：
 * - 流式增量只驻内存（`publishTransient`），落盘的是整条 `assistant/message`
 * - 模型报错不假装成功：落 `assistant/attempt`，明确告诉用户怎么回事，再结束回合
 * - 打断后如果工具结果未知，`turn/end` 记 `unknown`（C7）
 */

import type {
  ChatMessage,
  LlmChunk,
  LlmRequest,
  ToolCallRequest,
} from "../models/llm.js";
import type { SessionEvent } from "../../shared/session/events.js";
import type { ModelCatalog } from "../models/catalog.js";
import type { SessionHandle } from "../session/handle.js";
import type { Logger } from "../boot/logger.js";
import type { ToolPipeline } from "../tools/pipeline.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ApprovalBroker } from "../tools/approval.js";
import { activeSummary, buildTurnContext } from "./context.js";
import { COMPRESS_AT, DEFAULT_CONTEXT_TOKENS, compressionCut, estimateTokens, summarize, transcriptFor } from "./compress.js";
import { buildSystemPrompt } from "./prompt/system.js";

export const MAX_STEPS = 8;

export interface TurnDeps {
  readonly models: ModelCatalog;
  readonly tools: ToolPipeline;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly logger: Logger;
  readonly language: () => "zh-CN" | "en";
  readonly workspacePath: () => string;
  readonly maxSteps?: number;
  /** 本工作区其它对话保存的共享上下文（胶囊），新对话开始时带入。 */
  readonly sharedContext?: (session: SessionHandle) => string;
}

export interface TurnInput {
  readonly session: SessionHandle;
  readonly turnId: string;
  readonly text: string;
  readonly attachments: readonly string[];
  readonly modelId: string;
  readonly signal: AbortSignal;
}

export type TurnStatus = "completed" | "interrupted" | "unknown";

export class TurnRunner {
  constructor(private readonly deps: TurnDeps) {}

  private get maxSteps(): number {
    return this.deps.maxSteps ?? MAX_STEPS;
  }

  async run(input: TurnInput): Promise<TurnStatus> {
    const { session, signal } = input;
    const language = this.deps.language();
    let sawUncertain = false;
    let status: TurnStatus = "completed";
    let reason: string | undefined;

    session.append("turn/start", { chatId: session.sessionId });
    session.append("user/message", {
      text: input.text,
      attachments: [...input.attachments],
    });

    let client;
    try {
      client = this.deps.models.clientFor(input.modelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session.append("assistant/message", { step: 0, text: message });
      session.append("turn/end", { status: "completed", reason: "model_unavailable" });
      return "completed";
    }

    const profile = this.deps.models.get(input.modelId);
    const system = buildSystemPrompt({
      workspacePath: this.deps.workspacePath(),
      toolNames: this.deps.registry.names(),
      language,
      model: profile.model,
    });
    const toolSpecs = this.deps.registry.specs();
    const shared = this.deps.sharedContext?.(session) ?? "";
    const contextWindow = profile.contextWindow ?? DEFAULT_CONTEXT_TOKENS;

    try {
      // 每个 step 只允许重试一次。重试不走 step 自增，所以这里是 while 而不是 for：
      // `continue` 只表示"同一个 step 再来一次"，step 只在一次成功的步骤收尾时前进。
      // 早期用 `step -= 1` 抵消 for 的自增，只要模型持续返回 retryable 就永不结束。
      const retriedSteps = new Set<number>();
      let step = 0;
      while (step < this.maxSteps) {
        if (signal.aborted) {
          status = sawUncertain ? "unknown" : "interrupted";
          break;
        }
        const view = session.view();
        const rewind = view.rewind === null ? null : { toSeq: view.rewind.toSeq, seq: view.rewind.seq };
        let messages = buildTurnContext({ events: session.allEvents(), system, rewind, shared });

        // 用到窗口的 80%：先把较早的对话交给当前模型概括，再继续这一步。
        if (contextUsed(session.allEvents(), rewind, messages) >= COMPRESS_AT * contextWindow) {
          const cut = compressionCut(session.allEvents(), rewind);
          const text = cut === null ? null : await summarize(client, transcriptFor(session.allEvents(), rewind, cut), signal);
          if (cut !== null && text !== null) {
            session.append("context/summary", { throughSeq: cut, text });
            messages = buildTurnContext({ events: session.allEvents(), system, rewind, shared });
          } else {
            this.deps.logger.warn({ sessionId: session.sessionId }, "上下文接近上限但没能压缩，退回按条数截断");
          }
        }

        session.append("request/header", {
          step,
          provider: profile.kind,
          model: profile.model,
          system,
          toolNames: this.deps.registry.names(),
        });

        const request: LlmRequest = { messages, tools: toolSpecs, signal };
        let text = "";
        const calls: ToolCallRequest[] = [];
        let failure: { message: string; retryable: boolean } | null = null;
        let usage: { inputTokens?: number; outputTokens?: number } | undefined;

        for await (const chunk of client.stream(request)) {
          if (signal.aborted) break;
          const handled = this.consume(chunk, session, step, text, calls);
          text = handled.text;
          if (handled.usage !== undefined) usage = handled.usage;
          if (handled.failure !== null) {
            failure = handled.failure;
            break;
          }
        }

        if (text !== "" || calls.length > 0) {
          session.append("assistant/message", {
            step,
            text,
            ...(usage === undefined ? {} : { usage }),
          });
        }

        if (signal.aborted) {
          status = sawUncertain ? "unknown" : "interrupted";
          break;
        }

        if (failure !== null) {
          session.append("assistant/attempt", {
            step,
            reason: failure.message,
            ...(text === "" ? {} : { partial: text }),
          });
          // 步骤不可重试或已达到重试上限，直接返回失败状态。
          if (!failure.retryable || retriedSteps.has(step)) {
            session.append("assistant/message", {
              step,
              text: `${language === "zh-CN" ? "模型调用失败" : "Model call failed"}：${failure.message}`,
            });
            reason = "model_error";
            break;
          }
          // C6：超长/可重试错误显式失败并重试一次。重试沿用同一个 step。
          retriedSteps.add(step);
          session.append("assistant/message", {
            step,
            text:
              language === "zh-CN"
                ? `这一步失败了，正在重试一次：${failure.message}`
                : `This step failed; retrying once: ${failure.message}`,
          });
          continue;
        }

        if (calls.length === 0) break;

        const workspace = this.deps.workspacePath();
        for (const call of calls) {
          if (signal.aborted) break;
          const args = parseArgs(call.arguments);
          if (!args.ok) {
            session.append("tool/call", { callId: call.id, name: call.name, args: call.arguments });
            session.append("tool/result", {
              callId: call.id,
              outcome: {
                status: "error",
                code: "invalid_args",
                message: args.message,
                retryable: true,
              },
            });
            continue;
          }
          const { outcome } = await this.deps.tools.run({
            session,
            workspaceId: session.meta.workspace,
            workspacePath: workspace,
            mode: "write",
            name: call.name,
            args: args.value,
            signal,
          });
          if (outcome.status === "uncertain") sawUncertain = true;
        }
        // 一次完整步骤（含工具执行）收尾：走到这里才进入下一步。
        step += 1;
      }

      if (status === "completed" && signal.aborted) {
        status = sawUncertain ? "unknown" : "interrupted";
      }
    } catch (error) {
      this.deps.logger.error({ error, turnId: input.turnId }, "回合异常");
      session.append("assistant/message", {
        step: this.maxSteps,
        text: `${language === "zh-CN" ? "回合异常中止" : "Turn aborted by an internal error"}：${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      status = sawUncertain ? "unknown" : "interrupted";
    } finally {
      this.deps.approvals.resetTurnScope();
    }

    session.append("turn/end", {
      status,
      ...(reason === undefined ? {} : { reason }),
    });
    return status;
  }

  private consume(
    chunk: LlmChunk,
    session: SessionHandle,
    step: number,
    text: string,
    calls: ToolCallRequest[],
  ): {
    text: string;
    usage?: { inputTokens?: number; outputTokens?: number };
    failure: { message: string; retryable: boolean } | null;
  } {
    if (chunk.type === "text") {
      const next = text + chunk.text;
      // 流式增量只驻内存：借下一次写入的序号送给订阅者。
      session.publishTransient({
        type: "request/delta",
        seq: session.lastSeq + 1,
        at: new Date().toISOString(),
        step,
        text: chunk.text,
      });
      return { text: next, failure: null };
    }
    if (chunk.type === "tool-call") {
      calls.push(chunk.call);
      return { text, failure: null };
    }
    if (chunk.type === "done") {
      return chunk.usage === undefined
        ? { text, failure: null }
        : { text, usage: chunk.usage, failure: null };
    }
    return { text, failure: { message: chunk.message, retryable: chunk.retryable } };
  }
}

function parseArgs(raw: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return {
      ok: false,
      message: `工具参数不是合法 JSON：${String(error)}。`,
    };
  }
}

/**
 * 这次请求大概要用多少上下文：取"上一次请求的真实输入 token"和"本次估算"的较大者。
 * 真实用量只认最新摘要之后的那次——压缩前的用量已经不代表现在。
 */
function contextUsed(
  events: readonly SessionEvent[],
  rewind: { readonly toSeq: number; readonly seq: number } | null,
  messages: readonly ChatMessage[],
): number {
  const summarySeq = activeSummary(events, rewind)?.seq ?? 0;
  let measured = 0;
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event === undefined || event.seq <= summarySeq) break;
    if (event.type === "assistant/message" && event.usage?.inputTokens !== undefined) {
      measured = event.usage.inputTokens;
      break;
    }
  }
  return Math.max(measured, estimateTokens(messages));
}
