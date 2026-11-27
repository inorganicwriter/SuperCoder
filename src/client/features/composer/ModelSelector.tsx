/**
 * 模型选择弹层（对应 Python 版的 `#modelSelectorPopover`）。
 *
 * 同时支持将已就绪的外部 Agent 设为 Superagent 主控，或切回 LLM 模型档案。
 */

import { useState } from "react";
import { userModels } from "../../../shared/domain/model.js";
import { t } from "../../locale/index.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import styles from "./modelSelector.module.css";

export function ModelSelector({ onOpenModels }: { readonly onOpenModels: () => void }): JSX.Element {
  const state = useClientState();
  const store = useStore();
  const [open, setOpen] = useState(false);

  // 旧数据里残留的离线档案不参与选择。
  const models = userModels(state.models);
  const runnableAgents = state.agents.filter(
    (agent) => agent.installed && agent.level !== null && agent.level !== 4,
  );
  // 只显示默认档案：没有默认时不回退到第一项，否则显示的名字与实际调用的模型不一致。
  const activeModel = models.find((model) => model.default);
  const usingExternal = state.superagent.kind === "agent";
  const activeExternalId = state.superagent.kind === "agent" ? state.superagent.agentId : null;
  const activeAgent =
    activeExternalId === null ? undefined : state.agents.find((agent) => agent.id === activeExternalId);
  const agentReady =
    activeAgent !== undefined && activeAgent.installed && activeAgent.level !== null && activeAgent.level !== 4;
  const isReady = usingExternal ? agentReady : activeModel !== undefined;
  const label = usingExternal
    ? `${activeAgent?.label ?? activeExternalId ?? ""} · ${t("model.agentTag")}`
    : activeModel === undefined
      ? t("model.noModel")
      : displayName(activeModel);

  const close = (): void => setOpen(false);

  return (
    <div className={styles.wrap}>
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        aria-label={t("composer.model")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={isReady ? styles.dot : styles.dotEmpty} />
        <span className={styles.triggerLabel}>{label}</span>
        <span className={styles.caret}>▾</span>
      </button>

      {open ? (
        <>
          <div className={styles.backdrop} onClick={close} />
          <div className={styles.popover} role="dialog" aria-label={t("composer.model")}>
            <div className={styles.head}>
              <span>{t("composer.model")}</span>
              <span className={styles.count}>{runnableAgents.length + models.length}</span>
            </div>

            {runnableAgents.length > 0 ? (
              <>
                <div className={styles.sectionTitle}>{t("model.superagentAgents")}</div>
                <ul className={styles.list}>
                  {runnableAgents.map((agent) => {
                    const isActive = usingExternal && activeExternalId === agent.id;
                    return (
                      <li key={agent.id} className={styles.item}>
                        <button
                          type="button"
                          className={styles.itemMain}
                          onClick={() => {
                            close();
                            void store.setSuperagent({ kind: "agent", agentId: agent.id });
                          }}
                        >
                          <span className={styles.itemTop}>
                            <span className={isActive ? styles.nameActive : styles.name}>{agent.label}</span>
                            <span className={styles.chip}>{t("model.agentTag")}</span>
                          </span>
                          {agent.selectedModel ? (
                            <span className={styles.keyLine}>{agent.selectedModel}</span>
                          ) : null}
                        </button>
                        {isActive ? <span className={styles.inUse}>{t("model.inUse")}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              </>
            ) : null}

            {models.length === 0 ? (
              <div className={styles.empty}>
                <p>{t("model.empty")}</p>
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() => {
                    close();
                    onOpenModels();
                  }}
                >
                  ＋ {t("model.addFirst")}
                </button>
              </div>
            ) : (
              <>
                {runnableAgents.length > 0 ? (
                  <div className={styles.sectionTitle}>{t("model.apiModels")}</div>
                ) : null}
                <ul className={styles.list}>
                  {models.map((model) => {
                    const isActive = !usingExternal && model.id === activeModel?.id;
                    return (
                      <li key={model.id} className={styles.item}>
                        <button
                          type="button"
                          className={styles.itemMain}
                          onClick={() => {
                            close();
                            void store.saveModel({ ...model, default: true }).then((saved) => {
                              if (saved && usingExternal) {
                                void store.setSuperagent({ kind: "model" });
                              }
                            });
                          }}
                        >
                          <span className={styles.itemTop}>
                            <span className={isActive ? styles.nameActive : styles.name}>
                              {displayName(model)}
                            </span>
                            <span className={styles.chip}>{providerLabel(model)}</span>
                          </span>
                          <span className={styles.keyLine}>
                            {t("model.key")} {maskedKey(model)}
                          </span>
                        </button>
                        {isActive ? (
                          <span className={styles.inUse}>{t("model.inUse")}</span>
                        ) : (
                          <button
                            type="button"
                            className={styles.remove}
                            title={t("model.remove")}
                            aria-label={t("model.remove")}
                            onClick={() => void store.removeModel(model.id)}
                          >
                            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                              <path d="M2 2L8 8M8 2L2 8" />
                            </svg>
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function displayName(model: { readonly id: string; readonly label: string; readonly model: string }): string {
  // 老界面显示的是 `model_name`：有具体模型名就用它，没有才退回档案标签。
  return model.model !== "" ? model.model : model.label;
}

function providerLabel(model: { readonly kind: string }): string {
  return model.kind;
}

/**
 * 密钥状态直接取回包里的 `hasKey`：它是宿主查 secrets 得到的。
 *
 * 不能用 `secretKey` 判断——它是键名，用户没填时宿主会回落到 `model:<id>`，
 * 于是"能正常对话"的档案会被标成缺密钥。
 */
function maskedKey(model: { readonly hasKey: boolean }): string {
  return model.hasKey ? t("model.keySet") : t("model.keyMissing");
}
