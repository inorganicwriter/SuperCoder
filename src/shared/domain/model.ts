/**
 * 模型档案。遵循架构设计规范（settings.json）、（模型调用）。
 *
 * 键名里不放编号、不放版本号（C8）：档案用用户可见的 id 区分。
 */

import { z } from "zod";

export const ModelProviderKindSchema = z.enum([
  "openai-compatible",
  "anthropic",
  "deepseek",
  "mock",
]);
export type ModelProviderKind = z.infer<typeof ModelProviderKindSchema>;

export const ModelProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: ModelProviderKindSchema,
  /** API 基址，例如 https://api.deepseek.com */ 
  baseUrl: z.string(),
  model: z.string().min(1),
  /** 密钥存放在 secrets.bin 里的键名；档案本身不落明文。 */
  secretKey: z.string().optional(),
  /** 供应商原生结构化输出：json_schema / tool / none。 */
  structuredOutput: z.enum(["json-schema", "json-object", "tool", "none"]).default("none"),
  maxOutputTokens: z.number().int().positive().optional(),
  /** 上下文窗口（token）。不填按 1M 估算；用到 80% 时自动压缩较早的对话。 */
  contextWindow: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  /**
   * 是否是当前默认模型。真值来自 settings.json 的 `defaultModel`；
   * `model.upsert` 带 `default: true` 就等于切换默认。
   */
  default: z.boolean().default(false),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/**
 * `model.list` 的回包：档案 + 密钥是否已配置。
 *
 * `hasKey` 是宿主侧查 `secrets` 得到的派生字段，不落盘（因此也不在 `ModelProfileSchema` 里）。
 * 界面凭它区分"配置文件缺密钥"与"能正常对话"，不再靠 `secretKey` 是否存在来猜——
 * `secretKey` 是键名，没填时宿主会回落到 `model:<id>`。
 */
export const ModelProfileViewSchema = ModelProfileSchema.extend({
  hasKey: z.boolean(),
});
export type ModelProfileView = z.infer<typeof ModelProfileViewSchema>;

export const ModelTestResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});
export type ModelTestResult = z.infer<typeof ModelTestResultSchema>;

/**
 * 已取消的离线模型档案。
 *
 * 旧版本的 `model.list()` 会插入一条 `mock` 档案，因此它出现在界面与回包里，
 * 仅用于测试替身，真实请求需由用户在模型管理中配置可用档案。
 *
 * 保留这两个函数是为了兼容旧数据：settings.json 里可能仍存着 `mock` 档案，
 * 读取时必须当作不存在，避免它重新出现在列表里或改变模型计数。
 */
export const OFFLINE_MODEL_ID = "mock";

/** 是否为已取消的离线档案（id 或 kind 命中都算）。 */
export function isOfflineModel(model: Pick<ModelProfile, "id" | "kind">): boolean {
  return model.id === OFFLINE_MODEL_ID || model.kind === "mock";
}

/** 过滤掉旧数据里的离线档案，返回用户配置的模型（保留回包上的派生字段）。 */
export function userModels<T extends Pick<ModelProfile, "id" | "kind">>(models: readonly T[]): T[] {
  return models.filter((model) => !isOfflineModel(model));
}
