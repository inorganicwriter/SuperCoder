/**
 * 任务沙箱出网审计与 Worktree 处置公共摘要区块。
 * 同时复用于对话卡片（TaskCard）与任务侧栏（TaskPanel）。
 */

import { useState } from "react";
import type { TaskView } from "../../../shared/domain/task.js";
import { t } from "../../locale/index.js";
import { useStore } from "../../render/SessionProvider.js";
import styles from "./conversation.module.css";

export const TASK_WORKTREE_STATE_KEY = {
  active: "task.worktreeActive",
  merged: "task.worktreeMerged",
  conflict: "task.worktreeConflict",
  kept: "task.worktreeKept",
  discarded: "task.worktreeDiscarded",
} as const;

export function TaskSandboxSummary({
  task,
  showWorktreeControls = true,
}: {
  readonly task: TaskView;
  readonly showWorktreeControls?: boolean;
}): JSX.Element | null {
  const store = useStore();
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [resolvingAi, setResolvingAi] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [allowedHosts, setAllowedHosts] = useState<readonly string[]>([]);
  const [lockedAllowlist, setLockedAllowlist] = useState(false);

  const worktree = task.worktree;
  const canResolveWorktree =
    showWorktreeControls && (worktree?.state === "conflict" || worktree?.state === "kept");
  const hasBlocked = Boolean(task.blockedHosts && task.blockedHosts.length > 0);
  const hasAllowed = Boolean(task.allowedHosts && task.allowedHosts.length > 0);

  if (!hasBlocked && !hasAllowed && !worktree?.message && actionMsg === null && !canResolveWorktree) {
    return null;
  }

  const toggleDiff = async (): Promise<void> => {
    if (diffOpen) {
      setDiffOpen(false);
      return;
    }
    const diff = await store.diffTaskWorktree(task.taskId);
    if (diff !== null) {
      setDiffText(diff.patch.trim() !== "" ? `${diff.stat}\n\n${diff.patch}` : t("task.worktreeEmptyDiff"));
      setDiffOpen(true);
    }
  };

  const applyWorktree = async (): Promise<void> => {
    setApplying(true);
    setActionMsg(null);
    const res = await store.applyTaskWorktree(task.taskId);
    setApplying(false);
    if (res !== null) {
      setActionMsg(res.message);
      if (res.applied) {
        setDiffOpen(false);
        setDiffText(null);
      }
    }
  };

  const discardWorktree = async (): Promise<void> => {
    setApplying(true);
    setActionMsg(null);
    const discarded = await store.discardTaskWorktree(task.taskId);
    setApplying(false);
    if (discarded) {
      setDiffOpen(false);
      setDiffText(null);
    }
  };

  const resolveWithAi = async (): Promise<void> => {
    setResolvingAi(true);
    setActionMsg(null);
    try {
      const sent = await store.resolveWorktreeConflict(task);
      if (sent) {
        setActionMsg(t("task.worktreeResolveSent"));
      }
    } finally {
      setResolvingAi(false);
    }
  };

  const observedHosts = task.allowedHosts ?? [];

  return (
    <>
      {hasBlocked ? (
        <div className={styles.blockedRow}>
          <span className={styles.taskFailure}>{t("task.netBlocked")}:</span>
          {task.blockedHosts!.map((host) => {
            const isAllowed = allowedHosts.includes(host);
            return (
              <span key={host} className={styles.blockedChip}>
                <code>{host}</code>
                <button
                  type="button"
                  className={styles.allowHostBtn}
                  disabled={isAllowed}
                  onClick={() => {
                    void store.allowAgentHost(task.agentId, host).then((ok) => {
                      if (ok) {
                        setAllowedHosts((prev) => (prev.includes(host) ? prev : [...prev, host]));
                      }
                    });
                  }}
                >
                  {isAllowed ? t("task.hostAllowed") : t("task.allowHost")}
                </button>
              </span>
            );
          })}
        </div>
      ) : null}

      {hasAllowed ? (
        <div className={styles.blockedRow}>
          <span className={styles.taskWorktreeMsg}>{t("task.netAllowed")}:</span>
          {observedHosts.map((entry) => (
            <span key={entry.host} className={styles.blockedChip}>
              <code>{entry.count > 1 ? `${entry.host} ×${entry.count}` : entry.host}</code>
            </span>
          ))}
          <button
            type="button"
            className={styles.allowHostBtn}
            disabled={lockedAllowlist}
            onClick={() => {
              const hosts = observedHosts.map((entry) => entry.host);
              void store.lockAgentAllowlist(task.agentId, hosts, false).then((ok) => {
                if (ok) setLockedAllowlist(true);
              });
            }}
          >
            {lockedAllowlist ? t("task.allowlistLocked") : t("task.lockAllowlist")}
          </button>
        </div>
      ) : null}

      {worktree?.message ? <p className={styles.taskWorktreeMsg}>{worktree.message}</p> : null}
      {actionMsg !== null ? <p className={styles.taskWorktreeMsg}>{actionMsg}</p> : null}

      {canResolveWorktree ? (
        <div className={styles.worktreeActions}>
          <button type="button" onClick={() => void toggleDiff()}>
            {diffOpen ? t("task.worktreeHideDiff") : t("task.worktreeViewDiff")}
          </button>
          <button type="button" disabled={applying || resolvingAi} onClick={() => void applyWorktree()}>
            {applying ? t("task.worktreeApplying") : t("task.worktreeApply")}
          </button>
          {worktree?.state === "conflict" ? (
            <button type="button" disabled={applying || resolvingAi} onClick={() => void resolveWithAi()}>
              {resolvingAi ? t("task.worktreeResolvingAi") : t("task.worktreeResolveAi")}
            </button>
          ) : null}
          <button type="button" disabled={applying || resolvingAi} onClick={() => void discardWorktree()}>
            {t("task.worktreeDiscard")}
          </button>
        </div>
      ) : null}
      {diffOpen && diffText !== null ? <pre className={styles.toolDetail}>{diffText}</pre> : null}
    </>
  );
}
