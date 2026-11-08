/**
 * 提问卡片。遵循架构设计规范（ask_user_decision）：选项点一下就走，也可以自己写。
 */

import { useState } from "react";
import type { QuestionView } from "../../../shared/session/derive.js";
import { t } from "../../locale/index.js";
import { useStore } from "../../render/SessionProvider.js";
import styles from "./cards.module.css";

export function QuestionCard({ question }: { readonly question: QuestionView }): JSX.Element {
  const store = useStore();
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);

  const answer = (value: string): void => {
    if (value.trim() === "") return;
    setSent(true);
    void store.answerQuestion(question.questionId, value.trim());
  };

  return (
    <div className={styles.card} id={`sc-question-${question.questionId}`}>
      <div className={styles.cardTitle}>{t("question.title")}</div>
      <div className={styles.cardBody}>{question.question}</div>
      {question.options.length > 0 ? (
        <div className={styles.optionRow}>
          {question.options.map((option) => (
            <button key={option} type="button" disabled={sent} onClick={() => answer(option)}>
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.cardRow}>
        <input
          className={styles.input}
          value={text}
          placeholder={t("question.answer")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") answer(text);
          }}
        />
        <button type="button" disabled={sent || text.trim() === ""} onClick={() => answer(text)}>
          {t("action.send")}
        </button>
      </div>
    </div>
  );
}
