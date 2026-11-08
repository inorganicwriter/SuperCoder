/**
 * 对话区。事件按 seq 排好后再分组：
 * - 用户消息单独一块（右侧气泡，下面是"编辑 / 回撤到此处"）；
 * - 两条用户消息之间的所有助手内容（文字、工具调用、任务分派卡片）归在同一个"SuperCoder"名下；
 * - 连续的工具调用收成一行"调用了 N 个工具"，展开才看明细；dispatch_task 由任务分派卡片代替；
 * - 等审批的工具与没回答的提问固定在对话末尾，不会随新内容漂到上面；
 * - 新内容到达时贴底滚动，用户往上翻看时不打断。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TaskView } from "../../../shared/domain/task.js";
import type { MessageView, QuestionView, ToolCallView } from "../../../shared/session/derive.js";
import { t } from "../../locale/index.js";
import { Markdown } from "../../render/Markdown.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import { ApprovalCard } from "../approvals/ApprovalCard.js";
import { QuestionCard } from "../approvals/QuestionCard.js";
import { TaskCard } from "./TaskCard.js";
import styles from "./conversation.module.css";

const VISIBLE_LIMIT = 200;

type Item =
  | { readonly kind: "message"; readonly seq: number; readonly message: MessageView }
  | { readonly kind: "tool"; readonly seq: number; readonly tool: ToolCallView }
  | { readonly kind: "question"; readonly seq: number; readonly question: QuestionView }
  | { readonly kind: "task"; readonly seq: number; readonly task: TaskView };

/** 助手块里的一段：文字、一组连续工具调用、一张任务分派卡片、一条已回答的提问。 */
type Part =
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | { readonly kind: "tools"; readonly key: string; readonly tools: readonly ToolCallView[] }
  | { readonly kind: "task"; readonly key: string; readonly task: TaskView }
  | { readonly kind: "answered"; readonly key: string; readonly question: QuestionView };

type Block =
  | { readonly kind: "user"; readonly key: string; readonly message: MessageView }
  | { readonly kind: "assistant"; readonly key: string; readonly parts: readonly Part[] };

const TOOL_STATE_KEY = {
  pending: "conversation.toolPending",
  "awaiting-approval": "conversation.toolAwaiting",
  running: "conversation.toolPending",
  ok: "conversation.toolOk",
  error: "conversation.toolError",
  uncertain: "conversation.toolUncertain",
} as const;

const TOOL_STATE_CLASS = {
  pending: "pending",
  "awaiting-approval": "awaitingApproval",
  running: "running",
  ok: "ok",
  error: "error",
  uncertain: "uncertain",
} as const;

/** 把按 seq 排好的条目分成用户块与助手块，助手块内再把连续的工具调用合并。 */
function toBlocks(items: readonly Item[]): Block[] {
  const blocks: Block[] = [];
  let parts: Part[] = [];
  const flush = (): void => {
    if (parts.length > 0) blocks.push({ kind: "assistant", key: `a-${parts[0]!.key}`, parts });
    parts = [];
  };
  for (const item of items) {
    if (item.kind === "message" && item.message.role === "user") {
      flush();
      blocks.push({ kind: "user", key: `u-${String(item.seq)}`, message: item.message });
      continue;
    }
    if (item.kind === "message") {
      if (item.message.text.trim() !== "") parts.push({ kind: "text", key: `m-${String(item.seq)}`, text: item.message.text });
      continue;
    }
    if (item.kind === "task") {
      parts.push({ kind: "task", key: `t-${item.task.childId}`, task: item.task });
      continue;
    }
    if (item.kind === "question") {
      // 还在等回答的提问固定在对话末尾（见 Conversation）；已回答或已过期的留在原位置。
      if (item.question.answer !== null || item.question.expired) parts.push({ kind: "answered", key: `q-${item.question.questionId}`, question: item.question });
      continue;
    }
    // dispatch_task 的进度由任务分派卡片展示，不再单列。
    if (item.tool.name === "dispatch_task" && item.tool.state !== "error" && item.tool.state !== "uncertain") continue;
    const last = parts[parts.length - 1];
    if (last?.kind === "tools") parts[parts.length - 1] = { ...last, tools: [...last.tools, item.tool] };
    else parts.push({ kind: "tools", key: `tools-${item.tool.callId}`, tools: [item.tool] });
  }
  flush();
  return blocks;
}

function ToolGroup({ tools }: { readonly tools: readonly ToolCallView[] }): JSX.Element {
  const failed = tools.filter((tool) => tool.state === "error" || tool.state === "uncertain").length;
  const running = tools.some((tool) => tool.state === "pending" || tool.state === "running" || tool.state === "awaiting-approval");
  const summary =
    tools.length === 1
      ? `${t("conversation.tool")} · ${tools[0]!.name}`
      : t("conversation.toolCount").replace("{n}", String(tools.length));
  return (
    <details className={styles.toolGroup}>
      <summary className={styles.toolSummary}>
        <span className={styles.toolSummaryText}>{summary}</span>
        {running ? <span className={`${styles.toolState} ${styles.running}`}>{t("conversation.toolPending")}</span> : null}
        {failed > 0 ? <span className={`${styles.toolState} ${styles.error}`}>{t("conversation.toolFailed").replace("{n}", String(failed))}</span> : null}
      </summary>
      <ul className={styles.toolList}>
        {tools.map((tool) => (
          <li key={tool.callId} className={styles.toolItem}>
            <span className={styles.toolName}>{tool.name}</span>
            <span className={`${styles.toolState} ${styles[TOOL_STATE_CLASS[tool.state]]}`}>{t(TOOL_STATE_KEY[tool.state])}</span>
            {tool.outcome !== null && tool.outcome.status !== "ok" ? (
              <pre className={styles.toolDetail}>{tool.outcome.status === "uncertain" ? tool.outcome.detail : tool.outcome.message}</pre>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * 贴底滚动：滚动容器是外层的 .scroll。只有用户本来就在底部附近（120px 内）时才跟随，
 * 往上翻看历史时不把人拽回去。
 */
function useStickToBottom(root: React.RefObject<HTMLDivElement>): void {
  const pinned = useRef(true);
  // 首次渲染可能是占位符（会话视图还没到），那时 root 是 null；所以监听器不能只在挂载时绑一次，
  // 每次渲染都确认一下绑在当前的滚动容器上。
  const bound = useRef<{ readonly scroller: HTMLElement; readonly onScroll: () => void } | null>(null);

  useLayoutEffect(() => {
    const scroller = root.current?.parentElement;
    if (scroller !== null && scroller !== undefined && bound.current?.scroller !== scroller) {
      if (bound.current !== null) bound.current.scroller.removeEventListener("scroll", bound.current.onScroll);
      const onScroll = (): void => {
        pinned.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
      };
      scroller.addEventListener("scroll", onScroll, { passive: true });
      bound.current = { scroller, onScroll };
    }
    if (scroller !== null && scroller !== undefined && pinned.current) scroller.scrollTop = scroller.scrollHeight;
  });

  useEffect(() => () => {
    if (bound.current !== null) bound.current.scroller.removeEventListener("scroll", bound.current.onScroll);
  }, []);
}

export function Conversation(): JSX.Element {
  const state = useClientState();
  const store = useStore();
  const view = state.view;
  const rootRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<{ readonly seq: number; readonly text: string } | null>(null);

  const items = useMemo<Item[]>(() => {
    if (view === null) return [];
    const merged: Item[] = [
      ...view.messages.map((message) => ({ kind: "message" as const, seq: message.seq, message })),
      ...view.tools.map((tool) => ({ kind: "tool" as const, seq: tool.seq, tool })),
      // 任务分派卡片按 spawn 的序号插进对话；旧日志派生出的任务没有序号时排到最后。
      ...view.tasks.map((task) => ({ kind: "task" as const, seq: task.seq ?? Number.MAX_SAFE_INTEGER, task })),
      ...view.questions.map((question) => ({ kind: "question" as const, seq: question.seq, question })),
    ];
    return merged.sort((left, right) => left.seq - right.seq);
  }, [view]);

  const hidden = Math.max(0, items.length - VISIBLE_LIMIT);
  const blocks = useMemo(() => toBlocks(hidden === 0 ? items : items.slice(hidden)), [items, hidden]);
  const awaiting = (view?.tools ?? []).filter((tool) => tool.state === "awaiting-approval");
  const unanswered = (view?.questions ?? []).filter((question) => question.answer === null && !question.expired);

  // 每次渲染（新事件、流式增量、任务输出）都检查是否贴底。
  useStickToBottom(rootRef);

  if (view === null) {
    return <div className={styles.placeholder}>{t("status.connecting")}</div>;
  }

  const submitEdit = async (seq: number, text: string): Promise<void> => {
    const value = text.trim();
    if (value === "") return;
    setEditing(null);
    // 重新发送＝回撤到这条之前，再把新内容发出去。
    await store.rewind(Math.max(0, seq - 1));
    await store.send(value);
  };

  const lastBlock = blocks[blocks.length - 1];
  const streamingInLast = view.streaming !== null && lastBlock?.kind === "assistant";

  return (
    <div ref={rootRef} className={styles.scroller}>
      {hidden > 0 ? <div className={styles.truncated}>{t("conversation.rewound")}（+{hidden}）</div> : null}

      {blocks.map((block, index) => {
        if (block.kind === "user") {
          const message = block.message;
          const isEditing = editing !== null && editing.seq === message.seq;
          return (
            <article key={block.key} className={styles.userRow}>
              <div className={styles.userBody}>
                {isEditing ? (
                  <div className={styles.editBox}>
                    <textarea
                      className={styles.editInput}
                      value={editing.text}
                      aria-label={t("conversation.edit")}
                      onChange={(event) => setEditing({ seq: message.seq, text: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setEditing(null);
                      }}
                    />
                    <p className={styles.editHint}>{t("conversation.editHint")}</p>
                    <div className={styles.editActions}>
                      <button type="button" className={styles.buttonSecondary} onClick={() => setEditing(null)}>
                        {t("action.cancel")}
                      </button>
                      <button
                        type="button"
                        className={styles.buttonPrimary}
                        disabled={editing.text.trim() === ""}
                        onClick={() => void submitEdit(message.seq, editing.text)}
                      >
                        {t("conversation.saveAndResend")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.userBubble}>{message.text}</div>
                    <div className={styles.actions}>
                      <button type="button" className={styles.actionButton} onClick={() => setEditing({ seq: message.seq, text: message.text })}>
                        {t("conversation.edit")}
                      </button>
                      <button type="button" className={styles.actionButton} onClick={() => void store.rewind(Math.max(0, message.seq - 1))}>
                        {t("conversation.rewindTo")}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </article>
          );
        }

        const isLast = index === blocks.length - 1;
        return (
          <article key={block.key} className={styles.assistant}>
            <span className={styles.assistantName}>
              {t("app.name")}
              {isLast && view.streaming !== null ? <span className={styles.streamingLabel}>{t("conversation.streaming")}</span> : null}
            </span>
            {block.parts.map((part) => {
              if (part.kind === "text") return <Markdown key={part.key} text={part.text} className={styles.assistantBody} />;
              if (part.kind === "tools") return <ToolGroup key={part.key} tools={part.tools} />;
              if (part.kind === "task") return <TaskCard key={part.key} task={part.task} />;
              return (
                <div key={part.key} className={styles.questionDone}>
                  {part.question.question} → {part.question.answer ?? t("question.expired")}
                </div>
              );
            })}
            {isLast && view.streaming !== null ? (
              <div className={styles.streamingBody} aria-live="polite">
                <Markdown text={view.streaming.text} className={styles.assistantBody} />
                <span className={styles.cursor} aria-hidden="true" />
              </div>
            ) : null}
          </article>
        );
      })}

      {view.streaming !== null && !streamingInLast ? (
        <article className={styles.assistant} aria-live="polite">
          <span className={styles.assistantName}>
            {t("app.name")}
            <span className={styles.streamingLabel}>{t("conversation.streaming")}</span>
          </span>
          <div className={styles.streamingBody}>
            <Markdown text={view.streaming.text} className={styles.assistantBody} />
            <span className={styles.cursor} aria-hidden="true" />
          </div>
        </article>
      ) : null}

      {/* 等你处理的事固定在末尾：审批与提问不会被后续内容顶到上面去。 */}
      {awaiting.length > 0 || unanswered.length > 0 ? (
        <div className={styles.pendingDock} id="sc-pending">
          {awaiting.map((tool) => (
            <ApprovalCard key={`ap-${tool.callId}`} callId={tool.callId} toolName={tool.name} />
          ))}
          {unanswered.map((question) => (
            <QuestionCard key={`q-${question.questionId}`} question={question} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
