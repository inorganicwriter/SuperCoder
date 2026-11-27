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
import { useClientState } from "../../render/SessionProvider.js";
import { TASK_WORKTREE_STATE_KEY, TaskSandboxSummary } from "./TaskSandboxSummary.js";
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

export const TaskCard = memo(function TaskCard({ task }: { readonly task: TaskView }): JSX.Element {
  const state = useClientState();
  const outputRef = useRef<HTMLDivElement>(null);
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
            {t(TASK_WORKTREE_STATE_KEY[worktree.state])}
          </span>
        ) : null}
        {!open ? <span className={styles.taskPreview}>{preview}</span> : null}
        <span className={`${styles.taskState} ${styles[`task_${task.state}`] ?? ""}`}>{t(STATE_KEY[task.state])}</span>
        <span className={styles.taskChevron} aria-hidden="true" />
      </summary>
      <div className={styles.taskBody}>
        <p className={styles.taskGoal}>{task.instruction.trim() !== "" ? task.instruction : task.goal}</p>
        {body !== null ? (
          <div ref={outputRef} className={styles.taskOutput} aria-live={running ? "polite" : "off"}>
            <Markdown text={body} />
            {running ? <span className={styles.cursor} aria-hidden="true" /> : null}
          </div>
        ) : running ? (
          <p className={styles.taskWaiting}>{t("task.waitingOutput")}</p>
        ) : null}
        {failure !== null ? <p className={styles.taskFailure}>{failure}</p> : null}
        <TaskSandboxSummary task={task} />
      </div>
    </details>
  );
});
