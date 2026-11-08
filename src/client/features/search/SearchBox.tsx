/**
 * 搜索弹窗（对应 Python 版的 `#searchModal`，Ctrl/⌘+K 打开）。
 *
 * 现在的 RPC 没有"全库搜索"这种口子，所以这里只搜两处能确定拿到的数据：
 * 会话标题（已在 `state.sessions` 里）和当前会话的消息（派生视图里）。
 * 结果上限 20 条 —— 弹窗是"跳转入口"，不是检索页面，不做分页假装自己搜得很全。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../locale/index.js";
import { useClientState } from "../../render/SessionProvider.js";
import styles from "./search.module.css";

const MAX_RESULTS = 20;

interface Hit {
  readonly kind: "session" | "message";
  readonly sessionId: string;
  readonly title: string;
  readonly detail: string;
}

export function SearchBox({ onPick }: { readonly onPick: (sessionId: string) => void }): JSX.Element {
  const state = useClientState();
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const hits = useMemo<Hit[]>(() => {
    const needle = query.trim().toLowerCase();
    if (needle === "") return [];
    const found: Hit[] = [];
    for (const session of state.sessions) {
      if (session.title.toLowerCase().includes(needle)) {
        found.push({
          kind: "session",
          sessionId: session.sessionId,
          title: session.title,
          detail: t("search.session"),
        });
      }
    }
    for (const message of state.view?.messages ?? []) {
      if (!message.text.toLowerCase().includes(needle)) continue;
      found.push({
        kind: "message",
        sessionId: state.activeSessionId ?? "",
        title: message.text.slice(0, 80),
        detail: message.role === "user" ? t("search.inMessage") : t("search.inReply"),
      });
    }
    return found.slice(0, MAX_RESULTS);
  }, [query, state.sessions, state.view, state.activeSessionId]);

  return (
    <div className={styles.box}>
      <input
        ref={input}
        className={styles.input}
        value={query}
        placeholder={t("search.placeholder")}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          const first = hits[0];
          if (event.key === "Enter" && first !== undefined) onPick(first.sessionId);
        }}
        aria-label={t("search.title")}
      />
      {query.trim() === "" ? (
        <p className={styles.hint}>{t("search.tip")}</p>
      ) : hits.length === 0 ? (
        <p className={styles.hint}>{t("search.noResult")}</p>
      ) : (
        <ul className={styles.list}>
          {hits.map((hit) => (
            <li key={`${hit.kind}-${hit.sessionId}-${hit.title}`}>
              <button type="button" className={styles.hit} onClick={() => onPick(hit.sessionId)}>
                <span className={styles.hitTitle}>{hit.title}</span>
                <span className={styles.hitDetail}>{hit.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
