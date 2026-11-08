/**
 * MCP 面板（设置页的一个分区）：列出服务器、添加、授权、删除。
 */

import { useState } from "react";
import { t } from "../../locale/index.js";
import { Select } from "../../render/Select.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import styles from "../settings/rows.module.css";

interface Draft {
  id: string;
  label: string;
  transport: "stdio" | "http";
  target: string;
  args: string;
}

const EMPTY: Draft = { id: "", label: "", transport: "stdio", target: "", args: "" };

export function McpPanel(): JSX.Element {
  const state = useClientState();
  const store = useStore();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const showForm = adding || state.servers.length === 0;
  const canSave = draft.id.trim() !== "" && draft.target.trim() !== "";

  const add = (): void => {
    if (!canSave) return;
    void store.addMcp({
      id: draft.id.trim(),
      label: draft.label.trim() === "" ? draft.id.trim() : draft.label.trim(),
      transport: draft.transport,
      target: draft.target.trim(),
      args: draft.args.trim() === "" ? [] : draft.args.trim().split(/\s+/),
      enabled: true,
    });
    setDraft(EMPTY);
    setAdding(false);
  };

  return (
    <div className={styles.panel}>
      {state.servers.length > 0 ? (
        <ul className={styles.list}>
          {state.servers.map((server) => (
            <li key={server.id} className={styles.row}>
              <div className={styles.main}>
                <div className={styles.titleLine}>
                  <span className={styles.name}>{server.label}</span>
                  <span className={styles.badge}>{server.connected === true ? t("mcp.connected") : t("mcp.disconnected")}</span>
                </div>
                <div className={styles.meta}>{server.transport} · {server.target}</div>
                {server.lastError !== null ? <div className={styles.warn}>{server.lastError}</div> : null}
              </div>
              <div className={styles.actions}>
                {server.transport === "http" ? (
                  <button type="button" className={styles.textButton} onClick={() => void store.authorizeMcp(server.id).then(setMessage)}>
                    {t("action.authorize")}
                  </button>
                ) : null}
                <button type="button" className={styles.textButton} onClick={() => void store.removeMcp(server.id)}>
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
            <span className={styles.formTitle}>{t("mcp.add")}</span>
            {state.servers.length > 0 ? (
              <button type="button" className={styles.textButton} onClick={() => { setAdding(false); setDraft(EMPTY); }}>
                {t("action.cancel")}
              </button>
            ) : null}
          </div>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>{t("mcp.id")}</span>
              <input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
            </label>
            <label className={styles.field}>
              <span>{t("mcp.label")}</span>
              <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
            </label>
            <div className={styles.field}>
              <span>{t("mcp.transport")}</span>
              <Select
                value={draft.transport}
                ariaLabel={t("mcp.transport")}
                options={[{ value: "stdio", label: "stdio" }, { value: "http", label: "http" }]}
                onChange={(next) => setDraft({ ...draft, transport: next as "stdio" | "http" })}
              />
            </div>
            <label className={styles.field}>
              <span>{t("mcp.target")}</span>
              <input value={draft.target} onChange={(event) => setDraft({ ...draft, target: event.target.value })} />
            </label>
            {draft.transport === "stdio" ? (
              <label className={`${styles.field} ${styles.wide}`}>
                <span>{t("mcp.args")}</span>
                <input value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} />
              </label>
            ) : null}
          </div>
          <div className={styles.formActions}>
            <button type="button" className={styles.primary} disabled={!canSave} onClick={add}>
              {t("action.save")}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button type="button" onClick={() => setAdding(true)}>＋ {t("mcp.add")}</button>
        </div>
      )}
    </div>
  );
}
