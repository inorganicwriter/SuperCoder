/**
 * Agent 的模型选择（`profile:<id>`）。遵循架构设计规范。
 *
 * 重点是"配置错误必须在任务分派之前暴露"：`dispatch_task` 的执行体里抛出的异常会被
 * pipeline 记成 `uncertain`（会有副作用），而档案被删时什么都没跑 —— 那是纯配置问题。
 * 断言 checkAgentModel 的返回状态与错误提示符合预期。
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore } from "../../src/host/boot/config.js";
import { SecretStore, createTestBackend } from "../../src/host/boot/secrets.js";
import { ModelCatalog, secretKeyOf } from "../../src/host/models/catalog.js";
import { agentModelConfig, checkAgentModel } from "../../src/host/models/agent-model.js";
import type { ModelProfile } from "../../src/shared/domain/model.js";
import { makeTempHome } from "../helpers/temp.js";

const PROFILE: ModelProfile = {
  id: "deepseek",
  label: "DeepSeek",
  kind: "openai-compatible",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  structuredOutput: "none",
  default: true,
};

function setup(profiles: ModelProfile[] = [PROFILE]) {
  const home = makeTempHome();
  const settings = new SettingsStore(home.paths);
  const saved = settings.save({
    ...DEFAULT_SETTINGS,
    models: profiles,
    defaultModel: profiles[0]?.id ?? null,
  });
  if (!saved.ok) throw new Error(saved.error.message);
  const secrets = new SecretStore(home.paths.secretsFile, createTestBackend());
  const models = new ModelCatalog({ settings, secrets });
  return { models, secrets, home };
}

describe("Agent Model Profile Resolution", () => {
  it("native model name resolves directly without additional configuration", () => {
    const { models, secrets } = setup();
    expect(agentModelConfig("codex", "gpt-5-codex", { models, secrets })).toBeUndefined();
    expect(checkAgentModel("codex", "gpt-5-codex", { models, secrets })).toEqual({ status: "ok" });
  });

  it("resolves profile and secret into valid API configuration", () => {
    const { models, secrets } = setup();
    secrets.set(secretKeyOf(PROFILE), "sk-test");
    const config = agentModelConfig("codex", `profile:${PROFILE.id}`, { models, secrets });
    expect(config).toEqual({ baseUrl: PROFILE.baseUrl, model: PROFILE.model, apiKey: "sk-test" });
    expect(checkAgentModel("codex", `profile:${PROFILE.id}`, { models, secrets }).status).toBe("ok");
  });
});

describe("Empty Secret Key", () => {
  it("treats empty API key as unconfigured and blocks dispatch before invocation", () => {
    const { models, secrets } = setup();
    secrets.set(secretKeyOf(PROFILE), "");
    expect(checkAgentModel("codex", `profile:${PROFILE.id}`, { models, secrets }).status).toBe("error");
  });
});

describe("Reserved Identifier", () => {
  it("blocks saving mock profile to prevent filtering as offline legacy profile", () => {
    const { models } = setup([]);
    expect(() => models.upsert({ ...PROFILE, id: "mock", label: "Mock" })).toThrow();
  });
});

describe("validates model profile readiness before task dispatch", () => {
  it("returns invalid_args specifying deleted profile ID", () => {
    const { models, secrets } = setup();
    const checked = checkAgentModel("codex", "profile:gone", { models, secrets });
    expect(checked.status).toBe("error");
    if (checked.status !== "error") return;
    expect(checked.code).toBe("invalid_args");
    expect(checked.message).toContain("已删除");
    expect(checked.message).toContain("gone");
    expect(checked.message).toContain("模型");
  });

  it("returns denied with instructions when profile exists without secret key", () => {
    const { models, secrets } = setup();
    const checked = checkAgentModel("codex", `profile:${PROFILE.id}`, { models, secrets });
    expect(checked.status).toBe("error");
    if (checked.status !== "error") return;
    expect(checked.code).toBe("denied");
    expect(checked.message).toContain("密钥");
  });

  it("rejects profile assignment for agents without model profile support", () => {
    const { models, secrets } = setup();
    secrets.set(secretKeyOf(PROFILE), "sk-test");
    const checked = checkAgentModel("kimi", `profile:${PROFILE.id}`, { models, secrets });
    expect(checked.status).toBe("error");
    if (checked.status !== "error") return;
    expect(checked.code).toBe("denied");
  });

  it("rejects non-OpenAI-compatible model profiles", () => {
    const anthropic: ModelProfile = { ...PROFILE, id: "claude", kind: "anthropic" };
    const { models, secrets } = setup([anthropic]);
    secrets.set(secretKeyOf(anthropic), "sk-test");
    const checked = checkAgentModel("codex", "profile:claude", { models, secrets });
    expect(checked.status).toBe("error");
    if (checked.status !== "error") return;
    expect(checked.code).toBe("invalid_args");
    expect(checked.message).toContain("OpenAI 兼容");
  });
});
