/**
 * 结构化输出。遵循架构设计规范（供应商原生结构化输出）、C6。
 *
 * 两条规矩：
 * - 用供应商原生能力（response_format / tool forced call），不靠提示词祈祷
 * - 输出解析失败时显式返回错误，避免使用不完整数据
 */

import type { z } from "zod";
import type { StructuredFormat } from "./llm.js";

export function jsonSchemaFormat(
  name: string,
  schema: Record<string, unknown>,
): StructuredFormat {
  return { kind: "json-schema", name, schema };
}

export type StructuredParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/**
 * 解析模型给的 JSON。失败时把"为什么"说清楚（而不是丢一个 undefined）。
 */
export function parseStructured<T>(text: string, schema: z.ZodType<T>): StructuredParse<T> {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, message: "模型没有返回任何内容，请重试。" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(trimmed));
  } catch (error) {
    return {
      ok: false,
      message: `模型输出不是合法 JSON：${String(error)}，请重试或更换模型。`,
    };
  }
  const checked = schema.safeParse(parsed);
  if (!checked.success) {
    const issues = checked.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `模型输出不符合约定结构：${issues}。` };
  }
  return { ok: true, value: checked.data };
}

/** 容忍 ```json 围栏与前后废话，但不容忍内容不对。 */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced !== null && fenced[1] !== undefined) return fenced[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return text.slice(first, last + 1);
  return text;
}
