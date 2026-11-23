import { describe, expect, it } from "vitest";
import { buildModelOptions, type ModelOptionTexts } from "../../src/client/features/agents/model-options.js";
import type { ModelProfileView } from "../../src/shared/domain/model.js";
import type { ProviderModel } from "../../src/shared/domain/provider.js";

const texts: ModelOptionTexts = { nativeGroup: "NATIVE", profileGroup: "PROFILE", inUse: "IN_USE", saved: "SAVED" };

const profile = (id: string, label: string, baseUrl: string): ModelProfileView => ({
  id,
  label,
  kind: "openai-compatible",
  baseUrl,
  model: label,
  structuredOutput: "none",
  default: false,
  hasKey: true,
});

const build = (input: { native?: ProviderModel[]; profiles?: ModelProfileView[]; selected?: string }) =>
  buildModelOptions({
    placeholder: "PLACEHOLDER",
    native: input.native ?? [],
    profiles: input.profiles ?? [],
    selected: input.selected ?? "",
    texts,
  });

describe("Agent 模型下拉选项", () => {
  it("同名模型带上 provider 前缀，两组各说一次组名", () => {
    const options = build({
      native: [
        { id: "a/one", label: "DeepSeek-V41-Flash", provider: "DeepSeek" },
        { id: "b/one", label: "DeepSeek-V41-Flash", provider: "DeepSeek Account" },
      ],
    });
    const labels = options.map((option) => option.label);
    expect(labels).toEqual(["PLACEHOLDER", "DeepSeek · DeepSeek-V41-Flash", "DeepSeek Account · DeepSeek-V41-Flash"]);
    expect(options.slice(1).map((option) => option.group)).toEqual(["NATIVE", "NATIVE"]);
  });

  it("当前使用只标与保存值相同的那一项，不标 Agent 报的 current", () => {
    const options = build({
      native: [
        { id: "a/one", label: "A", current: true, provider: "p" },
        { id: "a/two", label: "B", provider: "p" },
      ],
      selected: "a/two",
    });
    expect(options.filter((option) => option.hint === "IN_USE").map((option) => option.value)).toEqual(["a/two"]);
  });

  it("保存值不在清单里时显示已保存，而不是内部 ID", () => {
    const options = build({ native: [], selected: '["tai","deepseek-v4.1-flash"]' });
    expect(options[1]).toMatchObject({ value: '["tai","deepseek-v4.1-flash"]', label: "SAVED · tai · deepseek-v4.1-flash" });
    expect(options[1]?.group).toBeUndefined();
  });

  it("档案组用域名区分，选中的那个改成当前使用", () => {
    const options = build({
      profiles: [profile("p1", "flash", "https://api.inferknock.ai/v1"), profile("p2", "flash", "https://api.deepseek.com")],
      selected: "profile:p1",
    });
    const profiles = options.filter((option) => option.group === "PROFILE");
    expect(profiles.map((option) => [option.label, option.hint])).toEqual([
      ["flash", "IN_USE"],
      ["flash", "api.deepseek.com"],
    ]);
  });

  it("没有保存值时既没有已保存项，也没有当前使用标记", () => {
    const options = build({ native: [{ id: "a/one", label: "A", current: true, provider: "p" }], profiles: [profile("p1", "flash", "https://x.test")] });
    expect(options.map((option) => option.value)).toEqual(["", "a/one", "profile:p1"]);
    expect(options.some((option) => option.hint === "IN_USE")).toBe(false);
  });

  it("原生清单按 provider 名称排序，缺 provider 时只用标签", () => {
    const options = build({
      native: [
        { id: "z", label: "Zed", provider: "Zeta" },
        { id: "a", label: "Alpha", provider: "Alpha" },
        { id: "solo", label: "Solo" },
      ],
    });
    expect(options.map((option) => option.label)).toEqual(["PLACEHOLDER", "Solo", "Alpha · Alpha", "Zeta · Zed"]);
  });

  it("baseUrl 不是合法 URL 时原样当提示，不影响选项", () => {
    const options = build({ profiles: [profile("p1", "flash", "not-a-url")] });
    expect(options[1]).toMatchObject({ label: "flash", hint: "not-a-url" });
  });

  it("DeepSeek Harness 的真实清单：同名两条路线分得开，当前使用跟着保存值而不是 Agent 默认", () => {
    // 摘自 DSH 0.2.0-rc.2 的 session/new：provider 分组 + JSON 数组形式的 ID。
    const native: ProviderModel[] = [
      { id: '["tai","deepseek-v4.1-flash"]', label: "deepseek-v4.1-flash", current: true, provider: "tai" },
      { id: '["deepseek-official","deepseek-flash"]', label: "DeepSeek-V41-Flash", provider: "DeepSeek" },
      { id: '["deepseek-official","deepseek-v4-pro"]', label: "DeepSeek-V4-Pro", provider: "DeepSeek" },
      { id: '["deepseek-account","deepseek-flash"]', label: "DeepSeek-V41-Flash", provider: "DeepSeek Account" },
      { id: '["deepseek-account","deepseek-v4-pro"]', label: "DeepSeek-V4-Pro", provider: "DeepSeek Account" },
    ];
    const options = build({ native, selected: '["deepseek-account","deepseek-flash"]' });
    const labels = options.map((option) => option.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(options.filter((option) => option.hint === "IN_USE").map((option) => option.label)).toEqual(["DeepSeek Account · DeepSeek-V41-Flash"]);
  });
});
