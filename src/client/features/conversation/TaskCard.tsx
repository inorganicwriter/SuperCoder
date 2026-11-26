/**
 * 对话里的任务分派卡片。
 *
 * - 进行中：展开，实时显示 Agent 发回的输出并贴底；
 * - 结束后：折叠成一行（Agent、状态、结果第一行预览），点开看全文；失败的同样折叠，不占地方。
 * 数据全部来自任务视图（由 delegation/* 事件派生），这里只负责展示。
 */

import { memo, useEffect, useRef, useState } from "react";
import { isTerminalTaskState, type TaskView } from "../../../shared/domain/task.js";
import { t } from "../../locale/index.js";
import { Markdown } from "../../render/Markdown.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import styles from "./conversation.module.css";

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

const WORKTREE_STATE_KEY = {
  active: "task.worktreeActive",
  merged: "task.worktreeMerged",
  conflict: "task.worktreeConflict",
  kept: "task.worktreeKept",
  discarded: "task.worktreeDiscarded",
} as const;

export const TaskCard = memo(function TaskCard({ task }: { readonly task: TaskView }): JSX.Element {
  const state = useClientState();
  const store = useStore();
  const outputRef = useRef<HTMLDivElement>(null);
  const [diffText, setDiffText] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const running = !isTerminalTaskState(task.state);
  const hasConflict = task.worktree?.state === "conflict";
  // 进行中或存在 worktree 冲突时保持展开，其它终态自动收起。
  const [open, setOpen] = useState(running || hasConflict);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && !hasConflict) setOpen(false);
    if (running || hasConflict) setOpen(true);
    wasRunning.current = running;
  }, [running, hasConflict]);

  const label = state.agents.find((agent) => agent.id === task.agentId)?.label ?? task.agentId;
  const result = task.result;
  const body =
    task.output !== undefined && task.output.trim() !== ""
      ? task.output
      : result?.status === "ok"
        ? result.answer
        : null;
  const failure =
    result?.status === "failed"
      ? result.diagnostic.detail ?? result.diagnostic.category
      : result?.status === "unknown"
        ? result.observed
        : null;
  const preview = (failure ?? body ?? (task.instruction.trim() !== "" ? task.instruction : task.goal)).split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const worktree = task.worktree;
  const canResolveWorktree = worktree?.state === "conflict" || worktree?.state === "kept";

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

  // 新内容到达时贴底；用户往上翻看时不打断（离底部超过 80px 就不动）。
  useEffect(() => {
    const element = outputRef.current;
    if (element === null || !running) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 80) element.scrollTop = element.scrollHeight;
  }, [body, running]);

  return (
    <details
      className={styles.taskCard}
      id={`sc-task-${task.taskId}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className={styles.taskHead}>
        {running ? <span className={styles.pulse} aria-hidden="true" /> : null}
        <span className={styles.taskAgent}>{label}</span>
        {worktree ? (
          <span className={worktree.state === "conflict" ? styles.worktreeWarn : styles.worktreeBadge}>
            {t(WORKTREE_STATE_KEY[worktree.state])}
          </span>
        ) : null}
        {!open ? <span className={styles.taskPreview}>{preview}</span> : null}
        <span className={`${styles.taskState} ${styles[`task_${task.state}`] ?? ""}`}>{t(STATE_KEY[task.state])}</span>
        <span className={styles.taskChevron} aria-hidden="true" />
      </summary>
      <div className={styles.taskBody}>
        <p className={styles.taskGoal}>{task.instruction.trim() !== "" ? task.instruction : task.goal}</p>
        {task.blockedHosts && task.blockedHosts.length > 0 ? (
          <p className={styles.taskFailure}>{t("task.netBlocked")}: {task.blockedHosts.join(", ")}</p>
        ) : null}
        {body !== null ? (
          <div ref={outputRef} className={styles.taskOutput} aria-live={running ? "polite" : "off"}>
            <Markdown text={body} />
            {running ? <span className={styles.cursor} aria-hidden="true" /> : null}
          </div>
        ) : running ? (
          <p className={styles.taskWaiting}>{t("task.waitingOutput")}</p>
        ) : null}
        {failure !== null ? <p className={styles.taskFailure}>{failure}</p> : null}
        {worktree?.message ? <p className={styles.taskWorktreeMsg}>{worktree.message}</p> : null}
        {actionMsg !== null ? <p className={styles.taskWorktreeMsg}>{actionMsg}</p> : null}
        {canResolveWorktree ? (
          <div className={styles.worktreeActions}>
            <button type="button" onClick={() => void toggleDiff()}>
              {diffOpen ? t("task.worktreeHideDiff") : t("task.worktreeViewDiff")}
            </button>
            <button type="button" disabled={applying} onClick={() => void applyWorktree()}>
              {applying ? t("task.worktreeApplying") : t("task.worktreeApply")}
            </button>
            <button type="button" disabled={applying} onClick={() => void discardWorktree()}>
              {t("task.worktreeDiscard")}
            </button>
          </div>
        ) : null}
        {diffOpen && diffText !== null ? <pre className={styles.toolDetail}>{diffText}</pre> : null}
      </div>
    </details>
  );
});
