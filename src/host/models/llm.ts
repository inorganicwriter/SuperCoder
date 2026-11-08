/**
 * 模型调用。遵循架构设计规范（供应商原生结构化输出）、（流式只驻内存）。
 *
 * 一个接口、两个实现：
 * - `openai-compatible`：OpenAI / DeepSeek 这些同形状的 HTTP 接口，SSE 流式
 * - `mock`：按脚本回答的测试替身（产品里不再有离线模型档案，它只给测试用）
 *
 * C6 在这里落地：输出超过上限不截断，显式报错并说明可重试。
 */

import { z } from "zod";
import type { ModelProfile } from "../../shared/domain/model.js";

export interface ToolCallRequest {
  readonly id: string;
  readonly name: string;
  /** 模型给的原始 JSON 字符串；解析失败要显式报错，不能悄悄吞掉。 */
  readonly arguments: string;
}

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCallRequest[];
}

export interface LlmToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export type StructuredFormat =
  | { readonly kind: "json-schema"; readonly name: string; readonly schema: Record<string, unknown> }
  | { readonly kind: "json-object" }
  | { readonly kind: "tool"; readonly name: string; readonly schema: Record<string, unknown> }
  | { readonly kind: "none" };

export interface LlmRequest {
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly LlmToolSpec[];
  readonly structured?: StructuredFormat;
  readonly signal?: AbortSignal;
  readonly maxOutputChars?: number;
}

export type LlmChunk =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool-call"; readonly call: ToolCallRequest }
  | {
      readonly type: "done";
      readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number };
    }
  | { readonly type: "error"; readonly message: string; readonly retryable: boolean };

export interface LlmClient {
  readonly id: string;
  stream(request: LlmRequest): AsyncGenerator<LlmChunk>;
}

export const DEFAULT_MAX_OUTPUT_CHARS = 400_000;

export class LlmFailure extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "LlmFailure";
    this.retryable = retryable;
  }
}

/** 供应商原生结构化输出：按 profile 的声明拼 body 片段。 */
export function applyStructuredFormat(
  kind: ModelProfile["structuredOutput"],
  format: StructuredFormat | undefined,
  body: Record<string, unknown>,
): void {
  if (format === undefined || format.kind === "none") return;
  if (kind === "json-schema" && format.kind === "json-schema") {
    body["response_format"] = {
      type: "json_schema",
      json_schema: { name: format.name, schema: format.schema, strict: true },
    };
    return;
  }
  if (kind === "json-object" && (format.kind === "json-schema" || format.kind === "json-object")) {
    body["response_format"] = { type: "json_object" };
    return;
  }
  if (kind === "tool" && format.kind === "tool") {
    body["tools"] = [
      {
        type: "function",
        function: { name: format.name, description: "Return the final structured answer.", parameters: format.schema },
      },
    ];
    body["tool_choice"] = { type: "function", function: { name: format.name } };
  }
}

/** 把 zod schema 转成模型侧 JSON Schema（唯一源仍是 zod）。 */
export function jsonSchemaOf(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>;
}

export interface OpenAiCompatibleOptions {
  readonly profile: ModelProfile;
  readonly apiKey: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly baseUrlOverride?: string;
}

/**
 * OpenAI 兼容的流式客户端。
 *
 * 只做三件事：发请求、把 SSE 增量译成 chunk、把工具调用拼齐。
 * 任何一步失败都变成显式 error chunk（带 retryable），由上层决定重试与否。
 */
export class OpenAiCompatibleClient implements LlmClient {
  readonly id: string;
  private readonly profile: ModelProfile;
  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.profile = options.profile;
    this.id = options.profile.id;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(request: LlmRequest): AsyncGenerator<LlmChunk> {
    const body: Record<string, unknown> = {
      model: this.profile.model,
      messages: request.messages.map(toOpenAiMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.tools.length > 0) {
      body["tools"] = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }));
    }
    if (this.profile.temperature !== undefined) body["temperature"] = this.profile.temperature;
    if (this.profile.maxOutputTokens !== undefined) {
      body["max_tokens"] = this.profile.maxOutputTokens;
    }
    applyStructuredFormat(this.profile.structuredOutput, request.structured, body);

    const url = `${this.profile.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey === null ? {} : { authorization: `Bearer ${this.apiKey}` }),
        },
        body: JSON.stringify(body),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      yield { type: "error", message: `连接模型服务失败：${String(error)}`, retryable: true };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      yield {
        type: "error",
        message: `模型服务返回 ${response.status}：${text.slice(0, 300)}`,
        retryable,
      };
      return;
    }
    if (response.body === null) {
      yield { type: "error", message: "模型服务没有返回流", retryable: true };
      return;
    }

    const maxChars = request.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    let produced = 0;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    const pendingCalls = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const line of readSseLines(response.body, request.signal)) {
      if (line === "[DONE]") break;
      let parsed: OpenAiStreamChunk;
      try {
        parsed = JSON.parse(line) as OpenAiStreamChunk;
      } catch {
        yield { type: "error", message: `模型流里出现非 JSON 行：${line.slice(0, 120)}`, retryable: true };
        return;
      }
      if (parsed.usage !== undefined) {
        usage = {
          ...(parsed.usage.prompt_tokens === undefined ? {} : { inputTokens: parsed.usage.prompt_tokens }),
          ...(parsed.usage.completion_tokens === undefined
            ? {}
            : { outputTokens: parsed.usage.completion_tokens }),
        };
      }
      const choice = parsed.choices?.[0];
      if (choice === undefined) continue;
      const delta = choice.delta;
      if (delta?.content !== undefined && delta.content !== "") {
        produced += delta.content.length;
        if (produced > maxChars) {
          yield {
            type: "error",
            message: `模型输出超出长度限制（${maxChars} 字符），已中止当前操作以避免截断。`,
            retryable: true,
          };
          return;
        }
        yield { type: "text", text: delta.content };
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const current = pendingCalls.get(index) ?? { id: "", name: "", arguments: "" };
        pendingCalls.set(index, {
          id: call.id ?? current.id,
          name: call.function?.name ?? current.name,
          arguments: current.arguments + (call.function?.arguments ?? ""),
        });
      }
    }

    for (const [index, call] of [...pendingCalls.entries()].sort((left, right) => left[0] - right[0])) {
      yield {
        type: "tool-call",
        call: {
          id: call.id === "" ? `call-${index}` : call.id,
          name: call.name,
          arguments: call.arguments === "" ? "{}" : call.arguments,
        },
      };
    }
    yield usage === undefined ? { type: "done" } : { type: "done", usage };
  }
}

interface OpenAiStreamChunk {
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string;
      readonly tool_calls?: ReadonlyArray<{
        readonly index?: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }>;
    };
  }>;
}

function toOpenAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId ?? "" };
  }
  if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: message.content === "" ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

async function* readSseLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted === true) return;
      const { value, done } = await reader.read();
      if (done) {
        // 流结束：把 decoder 里没冲出来的尾巴接上，再按同一套规则处理剩余内容。
        // 最后一帧常常没有尾随换行，丢掉它等于悄悄截断结论（C6）。
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const raw = buffer.slice(0, at).replace(/\r$/, "");
        buffer = buffer.slice(at + 1);
        const line = raw.startsWith("data:") ? raw.slice(5).trim() : "";
        if (line !== "") yield line;
        at = buffer.indexOf("\n");
      }
    }
    // 收尾：缓冲区里可能只剩最后一行（没有换行结尾）。
    const tail = buffer.replace(/\r$/, "");
    const lastLine = tail.startsWith("data:") ? tail.slice(5).trim() : "";
    if (lastLine !== "") yield lastLine;
  } finally {
    reader.releaseLock();
  }
}

export interface MockScriptStep {
  readonly text?: string;
  readonly toolCalls?: readonly ToolCallRequest[];
}

/** 测试用的脚本化替身：按脚本回答，脚本用尽后回一句固定的话。 */
export class MockLlmClient implements LlmClient {
  readonly id = "mock";
  private cursor = 0;

  constructor(private readonly script: readonly MockScriptStep[] = []) {}

  async *stream(request: LlmRequest): AsyncGenerator<LlmChunk> {
    const scripted = this.script[this.cursor];
    const step = scripted ?? this.defaultStep(request);
    this.cursor += 1;
    // 默认回答按片段间隔一点送出，界面上能看出是流式的；测试脚本不加间隔。
    const pace = scripted === undefined ? 40 : 0;
    for (const call of step.toolCalls ?? []) {
      yield { type: "tool-call", call };
    }
    const text = step.text ?? "";
    if (text !== "") {
      for (const part of chunkText(text, scripted === undefined ? 6 : 24)) {
        if (pace > 0) await new Promise((resolve) => setTimeout(resolve, pace));
        yield { type: "text", text: part };
      }
    }
    yield { type: "done", usage: { inputTokens: 0, outputTokens: text.length } };
  }

  private defaultStep(request: LlmRequest): MockScriptStep {
    const last = [...request.messages].reverse().find((message) => message.role === "user");
    return {
      text: `（测试替身）收到：${last?.content ?? ""}。配置模型档案后即可接入真实模型。`,
    };
  }
}

function chunkText(text: string, size: number): string[] {
  const parts: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    parts.push(text.slice(offset, offset + size));
  }
  return parts;
}

export function createMockClient(script: readonly MockScriptStep[] = []): LlmClient {
  return new MockLlmClient(script);
}
