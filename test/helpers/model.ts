/**
 * 测试用的模型档案与假模型服务。
 *
 * 应用没有内置模型，`message.send` 在档案为空时会被拒绝。需要模型的测试先写一份档案，
 * 再把客户端换成假实现：`seedModel` + 覆盖 `clientFor`，或 `fakeModelFetch` 让真实的
 * OpenAiCompatibleClient 解析一条 SSE。
 */

import { DEFAULT_SETTINGS, type SettingsStore } from "../../src/host/boot/config.js";
import type { ModelProfile } from "../../src/shared/domain/model.js";

export const TEST_MODEL: ModelProfile = {
  id: "test-model",
  label: "测试模型",
  kind: "openai-compatible",
  baseUrl: "https://example.invalid/v1",
  model: "test-model",
  structuredOutput: "none",
  default: true,
};

export const FAKE_ANSWER = "这是测试模型给出的回答。";

/** 把档案写进 settings.json 并设为默认。 */
export function seedModel(settings: SettingsStore, profile: ModelProfile = TEST_MODEL): void {
  const saved = settings.save({ ...DEFAULT_SETTINGS, models: [profile], defaultModel: profile.id });
  if (!saved.ok) throw new Error(`写入测试模型失败：${saved.error.message}`);
}

/** 假模型服务：返回一条 SSE，供 OpenAiCompatibleClient 解析。 */
export function fakeModelFetch(answer: string = FAKE_ANSWER): typeof fetch {
  const frame = (payload: unknown): string => `data:${JSON.stringify(payload)}\n\n`;
  const body =
    frame({ choices: [{ delta: { content: answer } }] }) +
    frame({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 6 } }) +
    "data: [DONE]\n\n";
  return (async (): Promise<Response> =>
    new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
}
