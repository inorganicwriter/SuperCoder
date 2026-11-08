/**
 * 输入区。遵循架构设计规范 P2：发送 / 中断、模型选择、状态提示。
 *
 * 键盘：Enter 发送，Shift+Enter 换行（与常见聊天一致）。
 */

import { useState } from "react";
import { userModels } from "../../../shared/domain/model.js";
import { t } from "../../locale/index.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import { ModelSelector } from "./ModelSelector.js";
import styles from "./composer.module.css";

export function Composer({
  onOpenModels,
  onOpenWorkspace,
}: {
  readonly onOpenModels: () => void;
  readonly onOpenWorkspace: () => void;
}): JSX.Element {
  const state = useClientState();
  const store = useStore();
  const [text, setText] = useState("");
  const [plusOpen, setPlusOpen] = useState(false);
  const disabled = state.status !== "open";
  // 没有模型档案时发送会被宿主拒绝，这里先禁用按钮并给出提示。
  const profiles = userModels(state.models);
  const noModel = state.status === "open" && profiles.length === 0;
  // 档案在、但默认那个没填密钥：宿主同样会拒，提前说清楚，别等回合报错。
  const active = profiles.find((profile) => profile.default);
  const noKey = state.status === "open" && active !== undefined && !active.hasKey;
  const blocked = noModel || noKey;

  const send = (): void => {
    const value = text.trim();
    // 正在处理时也能发：store 会先打断当前这一轮再发出去（追问）。
    if (value === "" || disabled || blocked) return;
    setText("");
    // 没发出去（上一轮打断后仍没停）就把内容还给用户，不静默丢掉。
    void store.send(value).then((sent) => {
      if (!sent) setText((current) => (current === "" ? value : current));
    });
  };

  return (
    <div className={styles.composer}>
      <textarea
        className={styles.input}
        value={text}
        rows={3}
        placeholder={t("composer.placeholder")}
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className={styles.row}>
        <div className={styles.plusWrap}>
          <button
            type="button"
            className={styles.plusButton}
            aria-expanded={plusOpen}
            aria-label={t("composer.plus")}
            onClick={() => setPlusOpen((open) => !open)}
          >
            ＋
          </button>
          {plusOpen ? (
            <>
              <div className={styles.plusBackdrop} onClick={() => setPlusOpen(false)} />
              <ul className={styles.plusMenu} role="menu" aria-label={t("composer.plus")}>
                <li>
                  <button type="button" role="menuitem" disabled title={t("composer.attachWhy")}>
                    {t("composer.attach")}
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setPlusOpen(false);
                      onOpenWorkspace();
                    }}
                  >
                    {t("nav.workspaces")}
                  </button>
                </li>
                <li>
                  <button type="button" role="menuitem" disabled title={t("capsule.readOnly")}>
                    {t("capsule.add")}
                  </button>
                </li>
              </ul>
            </>
          ) : null}
        </div>
        <ModelSelector onOpenModels={onOpenModels} />
        <span className={styles.hint}>
          {noModel ? t("composer.noModel") : noKey ? t("composer.noKey") : state.busy ? t("composer.busy") : ""}
        </span>
        {state.busy && text.trim() === "" ? (
          <button type="button" className={styles.stopButton} onClick={() => void store.interrupt()}>
            {t("action.stop")}
          </button>
        ) : (
          <button
            type="button"
            className={styles.sendButton}
            onClick={send}
            disabled={disabled || blocked || text.trim() === ""}
          >
            {t("action.send")}
          </button>
        )}
      </div>
    </div>
  );
}
