/**
 * 任务面板。遵循架构设计规范 P4：任务状态、回执、重试与执行者探测结果都在这里。
 */

import { useState } from "react";
import { t } from "../../locale/index.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import { EMPTY_CONFIRMED, isConfirmed, toggleConfirmed, type ConfirmedTasks } from "./confirm.js";
import styles from "../panels.module.css";

const RECEIPT_STATES = ["queued", "submitted", "received", "returned"] as const;

function nativeModelLabel(agentId: string, model: string): string {
  if (agentId !== "deepseek-harness") return model;
  try {
    const pair: unknown = JSON.parse(model);
    if (Array.isArray(pair) && pair.length === 2 && pair.every((part: unknown) => typeof part === "string")) return `${pair[0]} / ${pair[1]}`;
  } catch { /* Preserve unknown native identifiers. */ }
  return model;
}

const RECEIPT_KEY = {
  queued: "receipt.queued",
  submitted: "receipt.submitted",
  received: "receipt.received",
  returned: "receipt.returned",
} as const;

const STATE_KEY = {
  spawned: "task.state.spawned",
  queued: "task.state.queued",
  submitted: "task.state.submitted",
  received: "task.state.received",
  returned: "task.state.returned",
  failed: "task.state.failed",
  aborted: "task.state.aborted",
  unknown: "task.state.unknown",
} as const;

export function TaskPanel(): JSX.Element {
  const state = useClientState();
  const store = useStore();
  // 按任务记：勾一个 unknown 任务不能顺手把别的 unknown 任务也授权了。
  const [confirmed, setConfirmed] = useState<ConfirmedTasks>(EMPTY_CONFIRMED);

  return (
    <div className={styles.stack}>
      <section className={styles.section}>
        <header className={styles.sectionHead}>
          <h2 className={styles.heading}>{t("nav.tasks")}</h2>
        </header>
        {state.tasks.length === 0 ? (
          <p className={styles.hint}>{t("task.none")}</p>
        ) : (
          <ul className={styles.list}>
            {state.tasks.map((task) => (
              <li key={task.taskId} className={styles.card}>
                <div className={styles.cardHead}>
                  <span className={`${styles.badge} ${styles[task.state]}`}>
                    {t(STATE_KEY[task.state])}
                  </span>
                  <span className={styles.mono}>{task.providerId}</span>
                  <span className={styles.dim}>{task.agentId}</span>
                </div>
                <div className={styles.goal}>
                  {t("task.goal")}：{task.goal}
                </div>
                <dl className={styles.kv}>
                  <dt>{t("task.provider")}</dt>
                  <dd>{task.agentId}</dd>
                  <dt>{t("task.mode")}</dt>
                  <dd>
                    {task.mode === "write" ? t("task.mode.write") : t("task.mode.readOnly")}
                  </dd>
                  <dt>{t("task.receipt")}</dt>
                  <dd className={styles.receipts}>
                    {RECEIPT_STATES.map((state) => {
                      const reached =
                        task.receipt !== null &&
                        RECEIPT_STATES.indexOf(task.receipt) >= RECEIPT_STATES.indexOf(state);
                      return (
                        <span
                          key={state}
                          className={reached ? styles.receiptOn : styles.receiptOff}
                          title={t(RECEIPT_KEY[state])}
                        >
                          {t(RECEIPT_KEY[state])}
                        </span>
                      );
                    })}
                  </dd>
                  <dt>{t("task.retryCount")}</dt>
                  <dd>{task.retryCount}</dd>
                </dl>
                {task.nativeSessionId ? <div className={styles.dim}>{t("task.nativeSession")}: {task.nativeSessionId}</div> : null}
                {task.selectedModel ? <div className={styles.dim}>{t("agent.modelLabel")}: {task.selectedModelName ?? (task.selectedModel.startsWith("profile:") ? state.models.find((model) => `profile:${model.id}` === task.selectedModel)?.model ?? task.selectedModel : nativeModelLabel(task.agentId, task.selectedModel))}</div> : null}
                {task.output ? (
                  <details open={task.result === null}>
                    <summary>{t("task.progress")}</summary>
                    <pre className={styles.result}>{task.output}</pre>
                  </details>
                ) : null}
                {task.result !== null ? (
                  <pre className={styles.result}>
                    {task.result.status === "ok"
                      ? task.result.answer
                      : task.result.status === "failed"
                        ? `${task.result.diagnostic.stage} / ${task.result.diagnostic.category}${
                            task.result.diagnostic.detail === undefined
                              ? ""
                              : ` — ${task.result.diagnostic.detail}`
                          }`
                        : task.result.status === "unknown"
                          ? task.result.observed
                          : task.result.status}
                  </pre>
                ) : null}
                {task.state === "unknown" ? (
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={isConfirmed(confirmed, task.taskId)}
                      onChange={(event) =>
                        setConfirmed(toggleConfirmed(confirmed, task.taskId, event.target.checked))
                      }
                    />
                    {t("task.retryConfirm")}
                  </label>
                ) : null}
                <div className={styles.actions}>
                  <button
                    type="button"
                    onClick={() =>
                      void store.retryTask(task.taskId, isConfirmed(confirmed, task.taskId))
                    }
                    disabled={task.state === "unknown" && !isConfirmed(confirmed, task.taskId)}
                  >
                    {t("action.retry")}
                  </button>
                  <button type="button" onClick={() => void store.cancelTask(task.taskId)}>
                    {t("action.cancel")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  );
}
