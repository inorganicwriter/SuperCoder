/**
 * 模型面板：已配置的模型列表 + 添加表单。
 *
 * 密钥只发 `secret.set`，从不出现在回包与日志里。
 * 列表为空时，这里是添加模型的唯一入口。
 */

import { useState } from "react";
import { OFFLINE_MODEL_ID, userModels, type ModelProfile } from "../../../shared/domain/model.js";
import { t } from "../../locale/index.js";
import { Select } from "../../render/Select.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import styles from "../settings/rows.module.css";

interface Draft {
  label: string;
  kind: ModelProfile["kind"];
  baseUrl: string;
  model: string;
  key: string;
  /** 选中的供应商预设；只影响表单预填，不进档案。 */
  preset: string;
}

/** 常见供应商预设。品牌名用英文原名，与官方文档对得上。 */
const PRESETS = [
  { id: "", name: "Custom", kind: "openai-compatible", baseUrl: "" },
  { id: "deepseek", name: "DeepSeek", kind: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  { id: "openai", name: "OpenAI", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
  { id: "google", name: "Google Gemini", kind: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-pro" },
  { id: "openrouter", name: "OpenRouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "" },
  { id: "moonshot", name: "Moonshot", kind: "openai-compatible", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2" },
  { id: "ollama", name: "Ollama (local)", kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", model: "" },
] as const satisfies ReadonlyArray<{ id: string; name: string; kind: ModelProfile["kind"]; baseUrl: string; model?: string }>;

const EMPTY_DRAFT: Draft = { label: "", kind: "openai-compatible", baseUrl: "", model: "", key: "", preset: "" };

/** 档案 id 由名称派生：小写、只留字母数字与连字符，撞名时加序号。 */
function deriveId(source: string, taken: ReadonlySet<string>): string {
  const base = source.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "model";
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${String(n)}`;
  return id;
}

export function ModelPanel(): JSX.Element {
  const state = useClientState();
  const store = useStore();
  // 侧栏徽标数的是同一个集合（见 shared/domain/model.ts 的 userModels）。
  const profiles = userModels(state.models);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const showForm = adding || profiles.length === 0;
  const canSave = draft.model.trim() !== "" && draft.baseUrl.trim() !== "";

  const save = async (): Promise<void> => {
    if (!canSave) return;
    const label = draft.label.trim() === "" ? draft.model.trim() : draft.label.trim();
    const profile: ModelProfile = {
      // "mock" 是旧离线档案的保留 id，读取时会被过滤，不能分给用户的档案。
      id: deriveId(label, new Set([OFFLINE_MODEL_ID, ...state.models.map((item) => item.id)])),
      label,
      kind: draft.kind,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      structuredOutput: "none",
      // 还没有默认模型时，新加的档案成为默认。
      default: !profiles.some((item) => item.default),
    };
    const saved = await store.saveModel(profile);
    if (saved && draft.key.trim() !== "") await store.setSecret(`model:${profile.id}`, draft.key.trim());
    if (saved) {
      setDraft(EMPTY_DRAFT);
      setAdding(false);
      setMessage(null);
    }
  };

  return (
    <div className={styles.panel}>
      {profiles.length > 0 ? (
        <ul className={styles.list}>
          {profiles.map((profile) => (
            <li key={profile.id} className={styles.row}>
              <div className={styles.main}>
                <div className={styles.titleLine}>
                  <span className={styles.name}>{profile.label}</span>
                  {profile.default ? <span className={styles.badge}>{t("model.default")}</span> : null}
                  {profile.hasKey ? null : <span className={styles.warn}>{t("model.keyMissing")}</span>}
                </div>
                <div className={styles.meta}>
                  {profile.model} · {profile.kind}
                </div>
              </div>
              <div className={styles.actions}>
                {profile.default ? null : (
                  <button type="button" className={styles.textButton} onClick={() => void store.saveModel({ ...profile, default: true })}>
                    {t("model.setDefault")}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.textButton}
                  disabled={testing !== null}
                  onClick={() => {
                    setTesting(profile.id);
                    void store.testModel(profile.id).then(setMessage).finally(() => setTesting(null));
                  }}
                >
                  {testing === profile.id ? t("model.testing") : t("action.test")}
                </button>
                <button type="button" className={styles.textButton} onClick={() => void store.removeModel(profile.id)}>
                  {t("action.remove")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {message !== null ? <p className={styles.message}>{message}</p> : null}

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.formHead}>
            <span className={styles.formTitle}>{t("model.add")}</span>
            {profiles.length > 0 ? (
              <button type="button" className={styles.textButton} onClick={() => { setAdding(false); setDraft(EMPTY_DRAFT); }}>
                {t("action.cancel")}
              </button>
            ) : null}
          </div>
          <div className={styles.grid}>
            <div className={styles.field}>
              <span>{t("model.provider")}</span>
              <Select
                value={draft.preset}
                ariaLabel={t("model.provider")}
                options={PRESETS.map((preset) => ({ value: preset.id, label: preset.name }))}
                onChange={(next) => {
                  const preset = PRESETS.find((item) => item.id === next);
                  if (preset === undefined) return;
                  setDraft({
                    ...draft,
                    preset: preset.id,
                    kind: preset.kind,
                    baseUrl: preset.baseUrl,
                    model: "model" in preset ? preset.model : "",
                    label: preset.id === "" ? "" : preset.name,
                  });
                }}
              />
            </div>
            <label className={styles.field}>
              <span>{t("model.label")}</span>
              <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
            </label>
            <label className={`${styles.field} ${styles.wide}`}>
              <span>{t("model.baseUrl")}</span>
              <input value={draft.baseUrl} placeholder="https://api.example.com/v1" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
            </label>
            <label className={styles.field}>
              <span>{t("model.name")}</span>
              <input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
            </label>
            <label className={styles.field}>
              <span>{t("model.key")}</span>
              <input type="password" value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} />
            </label>
          </div>
          <div className={styles.formActions}>
            <button type="button" className={styles.primary} disabled={!canSave} onClick={() => void save()}>
              {t("action.save")}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button type="button" onClick={() => setAdding(true)}>＋ {t("model.add")}</button>
        </div>
      )}
    </div>
  );
}
