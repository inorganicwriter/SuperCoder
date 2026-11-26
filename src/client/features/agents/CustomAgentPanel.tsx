import { useState } from "react";
import type { CustomAgent } from "../../../shared/domain/custom-agent.js";
import { t } from "../../locale/index.js";
import { Select } from "../../render/Select.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import styles from "./agents.module.css";

interface CustomDraft {
  editing: boolean;
  id: string;
  label: string;
  protocol: "acp" | "command";
  binary: string;
  argsText: string;
  enabled: boolean;
}

const EMPTY_DRAFT: CustomDraft = {
  editing: false,
  id: "",
  label: "",
  protocol: "acp",
  binary: "",
  argsText: "",
  enabled: true,
};

export function CustomAgentPanel(): JSX.Element {
  const state = useClientState();
  const store = useStore();
  const [draft, setDraft] = useState<CustomDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const openEdit = (agent: CustomAgent): void => {
    setDraft({
      editing: true,
      id: agent.id,
      label: agent.label,
      protocol: agent.protocol,
      binary: agent.binary,
      argsText: agent.args.join(" "),
      enabled: agent.enabled,
    });
  };

  const submit = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    const ok = await store.saveCustomAgent({
      id: draft.id.trim(),
      label: draft.label.trim(),
      protocol: draft.protocol,
      binary: draft.binary.trim(),
      args: draft.argsText.split(/\s+/).map((s) => s.trim()).filter((s) => s !== ""),
      enabled: draft.enabled,
    });
    setSaving(false);
    if (ok) setDraft(null);
  };

  return (
    <div className={styles.customSection}>
      <div className={styles.customHeader}>
        <div>
          <h4 className={styles.sandboxTitle}>{t("agent.customTitle")}</h4>
          <p className={styles.hint}>{t("agent.customHint")}</p>
        </div>
        {draft === null ? (
          <button type="button" onClick={() => setDraft(EMPTY_DRAFT)}>
            {t("agent.customAdd")}
          </button>
        ) : null}
      </div>

      {state.customAgents.length === 0 && draft === null ? (
        <p className={styles.hint}>{t("agent.customEmpty")}</p>
      ) : null}

      {state.customAgents.length > 0 ? (
        <ul className={styles.customList}>
          {state.customAgents.map((agent) => (
            <li key={agent.id} className={styles.customRow}>
              <div className={styles.customInfo}>
                <strong>{agent.label}</strong>
                <span className={styles.via}>
                  {agent.protocol === "acp" ? t("agent.customProtocolAcp") : t("agent.customProtocolCommand")}
                </span>
                {!agent.enabled ? <span className={styles.statusMuted}>{t("agent.customDisabled")}</span> : null}
                <code className={styles.customCmd}>
                  {agent.id} · {agent.binary} {agent.args.join(" ")}
                </code>
              </div>
              <div className={styles.customActions}>
                <button type="button" onClick={() => openEdit(agent)}>{t("agent.customEdit")}</button>
                <button type="button" onClick={() => void store.removeCustomAgent(agent.id)}>{t("action.remove")}</button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {draft !== null ? (
        <div className={styles.sandboxBox}>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span>{t("agent.customId")}</span>
              <input
                type="text"
                className={styles.input}
                value={draft.id}
                disabled={draft.editing}
                placeholder={t("agent.customIdPlaceholder")}
                onChange={(event) => setDraft({ ...draft, id: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              <span>{t("agent.customLabel")}</span>
              <input
                type="text"
                className={styles.input}
                value={draft.label}
                placeholder={t("agent.customLabelPlaceholder")}
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </label>
          </div>

          <div className={styles.fields}>
            <div className={styles.field}>
              <span>{t("agent.customProtocol")}</span>
              <Select
                value={draft.protocol}
                ariaLabel={t("agent.customProtocol")}
                options={[
                  { value: "acp", label: t("agent.customProtocolAcp") },
                  { value: "command", label: t("agent.customProtocolCommand") },
                ]}
                onChange={(next) => setDraft({ ...draft, protocol: next as "acp" | "command" })}
              />
            </div>
            <label className={styles.field}>
              <span>{t("agent.customBinary")}</span>
              <input
                type="text"
                className={styles.input}
                value={draft.binary}
                placeholder={t("agent.customBinaryPlaceholder")}
                onChange={(event) => setDraft({ ...draft, binary: event.target.value })}
              />
            </label>
          </div>

          <label className={styles.field}>
            <span>{t("agent.customArgs")}</span>
            <input
              type="text"
              className={styles.input}
              value={draft.argsText}
              placeholder={t("agent.customArgsPlaceholder")}
              onChange={(event) => setDraft({ ...draft, argsText: event.target.value })}
            />
          </label>

          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            <span>{t("agent.customEnabled")}</span>
          </label>

          <div className={styles.sandboxActions}>
            <button type="button" disabled={saving} onClick={() => void submit()}>
              {t("action.save")}
            </button>
            <button type="button" disabled={saving} onClick={() => setDraft(null)}>
              {t("action.cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
