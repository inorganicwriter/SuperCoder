/**
 * 模型档案的列表查询与默认配置校验。
 *
 * `list()` 只返回用户配置的档案：没有档案时是空数组，`defaultModelId` 为 null。
 * 侧栏徽标、模型面板、输入区选择器都基于同一个列表，计数不需要额外修正。
 */

import { describe, expect, it } from "vitest";
import { ModelCatalog, secretKeyOf } from "../../src/host/models/catalog.js";
import { DEFAULT_SETTINGS, SettingsStore } from "../../src/host/boot/config.js";
import { SecretStore, createTestBackend } from "../../src/host/boot/secrets.js";
import { isOfflineModel, userModels, type ModelProfile } from "../../src/shared/domain/model.js";
import { makeTempHome } from "../helpers/temp.js";

const DEEPSEEK: ModelProfile = {
  id: "deepseek",
  label: "DeepSeek",
  kind: "deepseek",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  structuredOutput: "none",
  default: false,
};

function catalogOf(home: ReturnType<typeof makeTempHome>, settings: SettingsStore): ModelCatalog {
  return new ModelCatalog({
    settings,
    secrets: new SecretStore(home.paths.secretsFile, createTestBackend()),
  });
}

describe("Model Profile Counting", () => {
  it("returns empty list and no default model when unconfigured", () => {
    const home = makeTempHome();
    const catalog = catalogOf(home, new SettingsStore(home.paths));

    expect(catalog.list()).toEqual([]);
    expect(userModels(catalog.list())).toHaveLength(0);
    expect(catalog.defaultModelId).toBeNull();
  });

  it("returns single entry marked as default when one profile is configured", () => {
    const home = makeTempHome();
    const settings = new SettingsStore(home.paths);
    expect(settings.save({ ...DEFAULT_SETTINGS, models: [DEEPSEEK], defaultModel: DEEPSEEK.id }).ok).toBe(true);
    const catalog = catalogOf(home, settings);

    const listed = catalog.list();
    expect(listed.map((model) => model.label)).toEqual(["DeepSeek"]);
    expect(listed[0]?.default).toBe(true);
    expect(catalog.defaultModelId).toBe(DEEPSEEK.id);
    // 界面各处直接用这个列表计数，不需要再过滤。
    expect(userModels(listed)).toHaveLength(listed.length);
  });

  it("clears default model and returns empty list after deleting sole profile", () => {
    const home = makeTempHome();
    const settings = new SettingsStore(home.paths);
    expect(settings.save({ ...DEFAULT_SETTINGS, models: [DEEPSEEK], defaultModel: DEEPSEEK.id }).ok).toBe(true);
    const catalog = catalogOf(home, settings);

    catalog.remove(DEEPSEEK.id);
    expect(catalog.list()).toEqual([]);
    expect(catalog.defaultModelId).toBeNull();
  });

  it("promotes remaining profile to default after default profile is deleted", () => {
    const home = makeTempHome();
    const settings = new SettingsStore(home.paths);
    const other: ModelProfile = { ...DEEPSEEK, id: "other", label: "Other" };
    expect(
      settings.save({ ...DEFAULT_SETTINGS, models: [DEEPSEEK, other], defaultModel: DEEPSEEK.id }).ok,
    ).toBe(true);
    const catalog = catalogOf(home, settings);

    catalog.remove(DEEPSEEK.id);
    // 还有档案就必须有一个默认，否则界面看着配好了却发不出消息。
    expect(catalog.defaultModelId).toBe("other");
    expect(catalog.list().map((model) => [model.id, model.default])).toEqual([["other", true]]);
  });

  it("falls back to first profile as default when referenced default is deleted", () => {
    const home = makeTempHome();
    const settings = new SettingsStore(home.paths);
    // 模拟手改过的文件：defaultModel 指向不存在的 id。
    expect(settings.save({ ...DEFAULT_SETTINGS, models: [DEEPSEEK], defaultModel: "gone" }).ok).toBe(true);
    const catalog = catalogOf(home, settings);

    const listed = catalog.list();
    expect(listed.filter((model) => model.default)).toHaveLength(1);
    expect(catalog.defaultModelId).toBe(DEEPSEEK.id);
  });

  it("hasKey indicates presence of stored secret rather than static schema property", () => {
    const home = makeTempHome();
    const settings = new SettingsStore(home.paths);
    expect(settings.save({ ...DEFAULT_SETTINGS, models: [DEEPSEEK], defaultModel: DEEPSEEK.id }).ok).toBe(true);
    const secrets = new SecretStore(home.paths.secretsFile, createTestBackend());
    const catalog = new ModelCatalog({ settings, secrets });

    // 没填密钥：档案里也没有 secretKey 字段，界面据此提示"缺少密钥"。
    expect(catalog.list()[0]?.hasKey).toBe(false);
    // 密钥写在默认键名 model:<id> 下：能正常对话，hasKey 必须为 true。
    secrets.set(secretKeyOf(DEEPSEEK), "sk-test");
    expect(catalog.list()[0]?.hasKey).toBe(true);
    expect(catalog.list()[0]?.secretKey).toBeUndefined();
  });

  it("ignores stale offline profiles in settings.json", () => {
    const home = makeTempHome();
    const settings = new SettingsStore(home.paths);
    const legacy: ModelProfile = { ...DEEPSEEK, id: "mock", label: "离线模型", kind: "mock", default: true };
    // save 只做格式校验，权限与业务规则在 catalog；这里模拟旧版本写下的文件。
    expect(settings.save({ ...DEFAULT_SETTINGS, models: [legacy], defaultModel: "mock" }).ok).toBe(true);
    const catalog = catalogOf(home, settings);

    expect(isOfflineModel(legacy)).toBe(true);
    expect(catalog.list()).toEqual([]);
    expect(catalog.defaultModelId).toBeNull();
  });

  it("upsert rejects offline profiles", () => {
    const home = makeTempHome();
    const catalog = catalogOf(home, new SettingsStore(home.paths));
    expect(() =>
      catalog.upsert({ ...DEEPSEEK, id: "mock", kind: "mock", label: "离线模型" }),
    ).toThrow(/真实供应商/);
  });
});
