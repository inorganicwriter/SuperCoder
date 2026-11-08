/**
 * 通知面板：待审批、待回答、结果未知。
 *
 * - 待审批 / 待回答：点一下跳到对话末尾的卡片去处理，处理完自然消失；
 * - 结果未知：点一下跳到它的任务分派卡片（可以在那里重试），右侧的「忽略」只把它从通知里移走。
 */

import type { InboxItem } from "../../../shared/session/derive.js";
import { t } from "../../locale/index.js";
import styles from "../panels.module.css";

const KIND_KEY = {
  approval: "inbox.approval",
  question: "inbox.question",
  "task-unknown": "inbox.unknown",
} as const;

export function InboxPanel({
  items,
  onPick,
  onDismiss,
}: {
  readonly items: readonly InboxItem[];
  readonly onPick: (item: InboxItem) => void;
  readonly onDismiss: (item: InboxItem) => void;
}): JSX.Element {
  if (items.length === 0) return <p className={styles.hint}>{t("inbox.empty")}</p>;

  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={`${item.kind}-${item.id}`} className={styles.inboxRow}>
          <button type="button" className={styles.inboxItem} onClick={() => onPick(item)}>
            <span className={styles.badge}>{t(KIND_KEY[item.kind])}</span>
            <span className={styles.inboxTitle}>{item.title}</span>
          </button>
          {item.kind === "task-unknown" ? (
            <button
              type="button"
              className={styles.inboxDismiss}
              title={t("inbox.dismiss")}
              aria-label={t("inbox.dismiss")}
              onClick={() => onDismiss(item)}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M2 2L8 8M8 2L2 8" />
                  </svg>
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
