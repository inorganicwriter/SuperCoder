/**
 * MCP 面板（设置页的一个分区）：列出服务器、添加、授权、删除。
 */

import { useState } from "react";
import { ENV_KEY_PATTERN, isValidProxyUrl, type NetworkMode } from "../../../shared/domain/sandbox.js";
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
  networkMode: NetworkMode;
  proxyUrl: string;
  envText: string;
}

const EMPTY: Draft = {
  id: "",
  label: "",
  transport: "stdio",
  target: "",
  args: "",
  networkMode: "inherit",
  proxyUrl: "",
  envText: "",
};

function mcpNetworkBadgeKey(mode: NetworkMode): "agent.netDirect" | "agent.netProxy" | "agent.netOffline" | null {
  if (mode === "direct") return "agent.netDirect";
  if (mode === "proxy") return "agent.netProxy";
  if (mode === "offline") return "agent.netOffline";
  return null;
}

export function McpPanel(): JSX.Element {
  const state = useClientState();
  const store = useStore();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const showForm = adding || state.servers.length === 0;
  const canSave = draft.id.trim() !== "" && draft.target.trim() !== "";

  const add = (): void => {
    if (!canSave) return;
    setFormError(null);
    const parsedEnv: Record<string, string> = {};
    if (draft.transport === "stdio" && draft.envText.trim() !== "") {
      for (const rawLine of draft.envText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line === "" || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) {
          setFormError(`${t("agent.sandboxInvalid")} (${line})`);
          return;
        }
        const key = line.slice(0, eq).trim();
        if (!ENV_KEY_PATTERN.test(key)) {
          setFormError(`${t("agent.sandboxInvalid")} (${key})`);
          return;
        }
        parsedEnv[key] = line.slice(eq + 1);
      }
    }
    const proxyTrimmed = draft.proxyUrl.trim();
    if (draft.transport === "stdio" && draft.networkMode === "proxy" && (proxyTrimmed === "" || !isValidProxyUrl(proxyTrimmed))) {
      setFormError(t("agent.sandboxInvalid"));
      return;
    }
    const hasSandbox =
      draft.networkMode !== "inherit" || Object.keys(parsedEnv).length > 0;
    void store.addMcp({
      id: draft.id.trim(),
      label: draft.label.trim() === "" ? draft.id.trim() : draft.label.trim(),
      transport: draft.transport,
      target: draft.target.trim(),
      args: draft.args.trim() === "" ? [] : draft.args.trim().split(/\s+/),
      enabled: true,
      ...(hasSandbox
        ? {
            sandbox: {
              networkMode: draft.networkMode,
              ...(draft.networkMode === "proxy" && proxyTrimmed !== "" ? { proxyUrl: proxyTrimmed } : {}),
              ...(Object.keys(parsedEnv).length > 0 ? { env: parsedEnv } : {}),
            },
          }
        : {}),
    });
    setDraft(EMPTY);
    setAdding(false);
  };

  return (
    <div className={styles.panel}>
      {state.servers.length > 0 ? (
        <ul className={styles.list}>
          {state.servers.map((server) => {
            const netBadge = server.sandbox ? mcpNetworkBadgeKey(server.sandbox.networkMode) : null;
            return (
              <li key={server.id} className={styles.row}>
                <div className={styles.main}>
                  <div className={styles.titleLine}>
                    <span className={styles.name}>{server.label}</span>
                    <span className={styles.badge}>{server.connected === true ? t("mcp.connected") : t("mcp.disconnected")}</span>
                    {netBadge !== null ? <span className={styles.badge}>{t(netBadge)}</span> : null}
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
            );
          })}
        </ul>
      ) : null}

      {message !== null ? <p className={styles.message}>{message}</p> : null}

      {showForm ? (
        <div className={styles.form}>
          <div className={styles.formHead}>
            <span className={styles.formTitle}>{t("mcp.add")}</span>
            {state.servers.length > 0 ? (
              <button type="button" className={styles.textButton} onClick={() => { setAdding(false); setDraft(EMPTY); setFormError(null); }}>
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
                onChange={(next) => {
                  const nextTransport = next as "stdio" | "http";
                  const resetNetwork =
                    nextTransport === "http" && (draft.networkMode === "proxy" || draft.networkMode === "direct");
                  setDraft({
                    ...draft,
                    transport: nextTransport,
                    ...(resetNetwork ? { networkMode: "inherit", proxyUrl: "" } : {}),
                  });
                }}
              />
            </div>
            <label className={styles.field}>
              <span>{t("mcp.target")}</span>
              <input value={draft.target} onChange={(event) => setDraft({ ...draft, target: event.target.value })} />
            </label>
            <div className={styles.field}>
              <span>{t("mcp.networkMode")}</span>
              <Select
                value={draft.networkMode}
                ariaLabel={t("mcp.networkMode")}
                options={
                  draft.transport === "http"
                    ? [
                        { value: "inherit", label: t("agent.netInherit") },
                        { value: "offline", label: t("agent.netOffline") },
                      ]
                    : [
                        { value: "inherit", label: t("agent.netInherit") },
                        { value: "direct", label: t("agent.netDirect") },
                        { value: "proxy", label: t("agent.netProxy") },
                        { value: "offline", label: t("agent.netOffline") },
                      ]
                }
                onChange={(next) => setDraft({ ...draft, networkMode: next as NetworkMode })}
              />
            </div>
            {draft.transport === "stdio" && draft.networkMode === "proxy" ? (
              <label className={styles.field}>
                <span>{t("mcp.proxyUrl")}</span>
                <input
                  value={draft.proxyUrl}
                  placeholder={t("agent.proxyUrlPlaceholder")}
                  onChange={(event) => setDraft({ ...draft, proxyUrl: event.target.value })}
                />
              </label>
            ) : null}
            {draft.transport === "stdio" ? (
              <>
                <label className={`${styles.field} ${styles.wide}`}>
                  <span>{t("mcp.args")}</span>
                  <input value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} />
                </label>
                <label className={`${styles.field} ${styles.wide}`}>
                  <span>{t("mcp.envVars")}</span>
                  <textarea
                    rows={2}
                    value={draft.envText}
                    placeholder={t("agent.envVarsPlaceholder")}
                    onChange={(event) => setDraft({ ...draft, envText: event.target.value })}
                  />
                </label>
              </>
            ) : null}
          </div>
          {formError !== null ? <p className={styles.warn}>{formError}</p> : null}
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
