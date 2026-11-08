/**
 * 模型档案。遵循架构设计规范（model.*）、（模型调用）。
 *
 * 档案落在 settings.json 里（同一份 `fields` 守卫）；密钥只进 secrets.bin。
 *
 * 没有内置档案：`list()` 只返回用户配置的模型，为空表示不可用，
 * 由 `agent/hub` 在开回合前拒绝（`denied`）并提示去添加。
 */

import { z } from "zod";
import { ModelProfileSchema, isOfflineModel, type ModelProfile, type ModelProfileView } from "../../shared/domain/model.js";
import { fail } from "../boot/failure.js";
import type { Settings, SettingsStore } from "../boot/config.js";
import type { SecretStore } from "../boot/secrets.js";
import { LlmFailure, OpenAiCompatibleClient, type LlmClient, type LlmRequest } from "./llm.js";

export function secretKeyOf(profile: ModelProfile): string {
  return profile.secretKey ?? `model:${profile.id}`;
}

export interface ModelCatalogDeps {
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  readonly fetchImpl?: typeof fetch;
}

export class ModelCatalog {
  private settings: Settings;

  constructor(private readonly deps: ModelCatalogDeps) {
    const loaded = deps.settings.load();
    this.settings = loaded.ok ? loaded.value : { ...loadedFallback() };
  }

  list(): ModelProfileView[] {
    // 旧版本往 settings.json 里写过离线档案，读取时一律忽略。
    const models = this.settings.models.filter((model) => !isOfflineModel(model));
    const defaultId = this.pickDefault(models);
    return models.map((model) => ({
      ...model,
      default: model.id === defaultId,
      hasKey: this.deps.secrets.has(secretKeyOf(model)),
    }));
  }

  get(id: string): ModelProfile {
    const found = this.list().find((model) => model.id === id);
    if (found === undefined) {
      fail("not_found", `没有这个模型档案：${id}`);
    }
    return found;
  }

  /** 当前默认模型；没有任何档案时是 null。 */
  get defaultModelId(): string | null {
    return this.pickDefault(this.list());
  }

  /**
   * 选中默认档案：只要还有档案就返回一个。
   *
   * `settings.defaultModel` 可能指向已删除的档案（手改文件、删除默认档案），
   * 这时退到第一条，而不是让"有模型但没有默认"的状态流到发送路径上。
   */
  private pickDefault(models: readonly ModelProfile[]): string | null {
    const wanted = this.settings.defaultModel;
    if (wanted !== null && models.some((model) => model.id === wanted)) return wanted;
    return models[0]?.id ?? null;
  }

  upsert(profile: ModelProfile): void {
    const parsed = ModelProfileSchema.safeParse(profile);
    if (!parsed.success) {
      fail("invalid_params", `模型档案不符合契约：${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    }
    if (isOfflineModel(profile)) {
      fail("invalid_params", "已停用离线 mock 模型，请选择真实供应商并配置可用档案。");
    }
    // 落盘用解析后的对象：界面可能把回包里的派生字段（hasKey）一起传回来，不能写进 settings.json。
    const saved = parsed.data;
    const others = this.settings.models.filter((model) => model.id === saved.id);
    const models =
      others.length === 0
        ? [...this.settings.models, saved]
        : this.settings.models.map((model) => (model.id === saved.id ? saved : model));
    //  没有"设为默认"的方法：upsert 带 default 即切换默认；
    // 没有默认模型时，指向刚保存的档案。
    const shouldDefault = saved.default || this.settings.defaultModel === null;
    this.persist({
      ...this.settings,
      models,
      ...(shouldDefault ? { defaultModel: saved.id } : {}),
    });
  }

  remove(id: string): void {
    const models = this.settings.models.filter((model) => model.id !== id);
    // 删掉的若是默认档案，让剩下的第一个接任：有档案就一定有默认。
    const nextDefault =
      this.settings.defaultModel === id
        ? (models.filter((model) => !isOfflineModel(model))[0]?.id ?? null)
        : this.settings.defaultModel;
    this.persist({ ...this.settings, models, defaultModel: nextDefault });
  }

  setDefault(id: string): void {
    this.get(id);
    this.persist({ ...this.settings, defaultModel: id });
  }

  /** 建客户端。缺密钥时给出可执行提示，而不是等 HTTP 401。 */
  clientFor(id: string): LlmClient {
    const profile = this.get(id);
    const apiKey = this.deps.secrets.get(secretKeyOf(profile));
    if (apiKey === null) {
      throw new LlmFailure(
        `模型档案 ${profile.label} 尚未配置密钥，请在模型管理面板中配置。`,
        false,
      );
    }
    return new OpenAiCompatibleClient({
      profile,
      apiKey,
      ...(this.deps.fetchImpl === undefined ? {} : { fetchImpl: this.deps.fetchImpl }),
    });
  }

  /** `model.test`：发一条最小请求，把结果说成人话。 */
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    const profile = this.get(id);
    let client: LlmClient;
    try {
      client = this.clientFor(id);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    const request: LlmRequest = {
      messages: [{ role: "user", content: "ping" }],
      tools: [],
      maxOutputChars: 4_000,
    };
    // 只报告能不能用和多快：模型对 ping 的回复是随口的话（常带 emoji），回显它没有信息量。
    const startedAt = Date.now();
    let text = "";
    try {
      for await (const chunk of client.stream(request)) {
        if (chunk.type === "text") text += chunk.text;
        if (chunk.type === "error") return { ok: false, message: chunk.message };
      }
    } catch (error) {
      return { ok: false, message: `调用失败：${String(error)}` };
    }
    return {
      ok: true,
      message: text.trim() === "" ? `${profile.label} 可连接，但没有返回内容` : `${profile.label} 可用 · ${String(Date.now() - startedAt)} ms`,
    };
  }

  private persist(next: Settings): void {
    const saved = this.deps.settings.save(next);
    if (!saved.ok) fail("storage_failed", saved.error.message);
    this.settings = next;
  }
}

function loadedFallback(): Settings {
  return {
    language: "zh-CN",
    defaultModel: null,
    approvalPolicy: "ask",
    verificationCommand: "git status --porcelain",
    mcpServers: [],
    models: [],
  };
}

/** `model.upsert` 的入参校验复用同一份 schema。 */
export const ModelProfileInputSchema = ModelProfileSchema;
export type ModelProfileInput = z.infer<typeof ModelProfileInputSchema>;
void z;
