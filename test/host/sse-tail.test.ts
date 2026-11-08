/**
 * SSE 流的收尾。遵循架构设计规范。
 *
 * `readSseLines` 早期在 `done` 时直接 break，缓冲区里最后一段（没有尾随换行）
 * 再没人处理：喂 `data:A\n\ndata:B\n\ndata:C`（C 后面没有换行）只得到 "AB"。
 * 丢的通常正是最后一句结论，属于"内容被悄悄截断"。
 */

import { describe, expect, it } from "vitest";
import type { ModelProfile } from "../../src/shared/domain/model.js";
import { OpenAiCompatibleClient, type LlmChunk } from "../../src/host/models/llm.js";

const PROFILE: ModelProfile = {
  id: "fake",
  label: "假模型",
  kind: "openai-compatible",
  baseUrl: "https://example.invalid/v1",
  model: "fake-model",
  structuredOutput: "none",
  default: false,
};

function sseResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(text: string): Promise<LlmChunk[]> {
  const client = new OpenAiCompatibleClient({
    profile: PROFILE,
    apiKey: "test",
    fetchImpl: (async () => sseResponse(text)) as unknown as typeof fetch,
  });
  const chunks: LlmChunk[] = [];
  for await (const chunk of client.stream({ messages: [{ role: "user", content: "ping" }], tools: [] })) {
    chunks.push(chunk);
  }
  return chunks;
}

function textOf(chunks: readonly LlmChunk[]): string {
  return chunks.map((chunk) => (chunk.type === "text" ? chunk.text : "")).join("");
}

function payload(content: string): string {
  return JSON.stringify({ choices: [{ delta: { content } }] });
}

describe("SSE Stream Tail Handling", () => {
  it("processes final frame cleanly even when missing trailing newline", async () => {
    const text = `data:${payload("A")}\n\ndata:${payload("B")}\n\ndata:${payload("C")}`;
    const chunks = await collect(text);
    expect(textOf(chunks)).toBe("ABC");
    // 正常收尾，不多产出。
    expect(chunks.filter((chunk) => chunk.type === "done")).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === "error")).toHaveLength(0);
  });

  it("completes stream cleanly upon receiving standard [DONE] sentinel", async () => {
    const text = `data:${payload("A")}\n\ndata: [DONE]`;
    const chunks = await collect(text);
    expect(textOf(chunks)).toBe("A");
    expect(chunks.filter((chunk) => chunk.type === "done")).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === "error")).toHaveLength(0);
  });
});
