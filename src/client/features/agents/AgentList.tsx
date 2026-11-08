import { useEffect, useState } from "react";
import type { ProviderModel, ProviderStatus } from "../../../shared/domain/provider.js";
import { t } from "../../locale/index.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import { Select, type SelectOption } from "../../render/Select.js";
import styles from "./agents.module.css";

const VIA = { 1: "agent.via1", 2: "agent.via2", 3: "agent.via3", 4: "agent.via4" } as const;

/** 刷新按钮放在设置页的标题行里，所以单独导出。 */
export function AgentRefreshButton(): JSX.Element {
  const store = useStore();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <button type="button" disabled={refreshing} onClick={() => {
      setRefreshing(true);
      void store.refreshAgents().finally(() => setRefreshing(false));
    }}>{refreshing ? t("agent.refreshing") : t("action.refresh")}</button>
  );
}

export function AgentList(): JSX.Element {
  const state = useClientState();
  return (
    <section className={styles.section}>
      <p className={styles.notes}>{t("agent.modelHint")} {t("agent.permissionHint")}</p>
      {state.agents.length === 0 ? <p className={styles.hint}>{t("agent.none")}</p> : (
        <ul className={styles.list}>{state.agents.map((agent) => <AgentRow key={agent.id} agent={agent} />)}</ul>
      )}
    </section>
  );
}

function AgentRow({ agent }: { agent: ProviderStatus }): JSX.Element {
  const store = useStore();
  const state = useClientState();
  const [models, setModels] = useState<ProviderModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const historyOnly = agent.level === 4;
  const hasInterface = agent.installed && agent.level !== null && !historyOnly;
  const canLoad = hasInterface && state.activeWorkspaceId !== "";
  const profiles = ["opencode", "codex", "deepseek-harness"].includes(agent.id)
    ? state.models.filter((item) => item.kind === "openai-compatible" || item.kind === "deepseek") : [];
  const selected = agent.selectedModel ?? "";

  useEffect(() => setModels(null), [state.activeWorkspaceId]);

  const load = (): void => {
    if (!canLoad || loading) return;
    setLoading(true);
    void store.listAgentModels(agent.id).then((items) => { if (items !== null) setModels(items); }).finally(() => setLoading(false));
  };

  // 按供应商分组：同组相邻、组内按名称排；SuperCoder 自己的档案单独一组放最后。
  const native = [...(models ?? [])].sort((left, right) =>
    (left.provider ?? "").localeCompare(right.provider ?? "") || left.label.localeCompare(right.label));
  const options: SelectOption[] = [
    { value: "", label: t("agent.modelPlaceholder") },
    ...(selected !== "" && !native.some((item) => item.id === selected) && !profiles.some((item) => `profile:${item.id}` === selected)
      ? [{ value: selected, label: selected }] : []),
    ...native.map((item) => ({ value: item.id, label: item.label, group: item.provider ?? t("agent.nativeModels"), ...(item.current ? { hint: t("agent.modelCurrent") } : {}) })),
    ...profiles.map((item) => ({ value: `profile:${item.id}`, label: item.label, hint: item.model, group: t("agent.modelProfile") })),
  ];

  return (
    <li className={styles.card}>
      <details className={styles.agent} onToggle={(event) => { if (event.currentTarget.open && models === null) load(); }}>
      <summary className={styles.cardHead}>
        <span className={hasInterface ? styles.dotReady : historyOnly ? styles.dotPartial : styles.dotOff} aria-hidden="true" />
        <strong className={styles.name}>{agent.label}</strong>
        {agent.level !== null && !historyOnly ? <span className={styles.via}>{t(VIA[agent.level])}</span> : null}
        <span className={hasInterface ? styles.statusReady : styles.statusMuted}>
          {historyOnly ? t("agent.historyOnly") : hasInterface ? t("agent.installed") : t("agent.missing")}
        </span>
        <span className={styles.chevron} aria-hidden="true" />
      </summary>
      <div className={styles.content}>
      {agent.reason ? <p className={styles.hint}>{agent.reason}</p> : null}
      {hasInterface ? (
        <div className={styles.fields}>
          {/* 每个 Agent 都是同样两列；不能由这里设置权限的，如实显示"随任务模式"。 */}
          <div className={styles.field}>
            <span>{t("agent.permissionLabel")}</span>
            {agent.permissionPolicy !== undefined ? (
              <Select
                value={agent.permissionPolicy}
                ariaLabel={t("agent.permissionLabel")}
                options={[{ value: "allow", label: t("agent.permissionAllow") }, { value: "deny", label: t("agent.permissionDeny") }]}
                onChange={(next) => void store.setAgentPermission(agent.id, next as "allow" | "deny")}
              />
            ) : (
              <Select
                value="task"
                disabled
                ariaLabel={t("agent.permissionLabel")}
                options={[{ value: "task", label: t("agent.permissionByTask") }]}
                onChange={() => undefined}
              />
            )}
          </div>
          <div className={styles.field}>
            <span className={styles.fieldHead}>
              {t("agent.modelLabel")}
              {canLoad ? (
                <button type="button" className={styles.link} disabled={loading} onClick={load}>
                  {loading ? t("agent.modelLoading") : t("agent.modelReload")}
                </button>
              ) : null}
            </span>
            <Select
              value={selected}
              ariaLabel={t("agent.modelLabel")}
              options={options}
              filterPlaceholder={t("agent.modelFilter")}
              onChange={(next) => void store.setAgentModel(agent.id, next === "" ? null : next)}
            />
          </div>
        </div>
      ) : null}
      {hasInterface && !canLoad ? <p className={styles.hint}>{t("agent.modelNeedsWorkspace")}</p> : null}
      {models?.length === 0 ? <p className={styles.hint}>{t("agent.modelNone")}</p> : null}
      </div>
      </details>
    </li>
  );
}
