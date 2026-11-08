/**
 * 共享上下文（胶囊）面板：列出本工作区各对话保存的胶囊，可编辑、可移除。
 *
 * 胶囊只在用户要求时由 SuperCoder 保存；"工作区共享"的胶囊会在新对话开始时带给模型。
 * 编辑与移除都追加到胶囊所在对话的日志里，历史版本仍可回看。
 */

import { useEffect, useState } from "react";
import type { Capsule } from "../../../shared/domain/capsule.js";
import { t } from "../../locale/index.js";
import { Markdown } from "../../render/Markdown.js";
import { Select } from "../../render/Select.js";
import { useClientState, useStore } from "../../render/SessionProvider.js";
import styles from "./capsules.module.css";

interface Draft {
  readonly title: string;
  readonly humanSummary: string;
  readonly technicalHandoff: string;
  readonly scope: Capsule["scope"];
}

function CapsuleItem({ capsule }: { readonly capsule: Capsule }): JSX.Element {
  const store = useStore();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  if (draft !== null) {
    return (
      <li className={styles.item}>
        <label className={styles.field}>
          <span>{t("capsule.title")}</span>
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </label>
        <label className={styles.field}>
          <span>{t("capsule.summary")}</span>
          <textarea rows={4} value={draft.humanSummary} onChange={(event) => setDraft({ ...draft, humanSummary: event.target.value })} />
        </label>
        <label className={styles.field}>
          <span>{t("capsule.handoff")}</span>
          <textarea rows={5} value={draft.technicalHandoff} onChange={(event) => setDraft({ ...draft, technicalHandoff: event.target.value })} />
        </label>
        <div className={styles.field}>
          <span>{t("capsule.scope")}</span>
          <Select
            value={draft.scope}
            ariaLabel={t("capsule.scope")}
            options={[
              { value: "workspace", label: t("capsule.scopeWorkspace") },
              { value: "chat", label: t("capsule.scopeChat") },
            ]}
            onChange={(next) => setDraft({ ...draft, scope: next as Capsule["scope"] })}
          />
        </div>
        <div className={styles.actions}>
          <button type="button" className={styles.textButton} onClick={() => setDraft(null)}>
            {t("action.cancel")}
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={saving || draft.title.trim() === ""}
            onClick={() => {
              setSaving(true);
              void store
                .updateCapsule({ sessionId: capsule.sessionId, capsuleId: capsule.capsuleId, ...draft, title: draft.title.trim() })
                .then((ok) => { if (ok) setDraft(null); })
                .finally(() => setSaving(false));
            }}
          >
            {t("action.save")}
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className={styles.item}>
      <div className={styles.head}>
        <span className={styles.title}>{capsule.title}</span>
        <span className={styles.scope}>{capsule.scope === "workspace" ? t("capsule.scopeWorkspace") : t("capsule.scopeChat")}</span>
        <span className={styles.spacer} />
        <button
          type="button"
          className={styles.textButton}
          onClick={() => setDraft({ title: capsule.title, humanSummary: capsule.humanSummary, technicalHandoff: capsule.technicalHandoff, scope: capsule.scope })}
        >
          {t("conversation.edit")}
        </button>
        <button type="button" className={styles.textButton} onClick={() => void store.removeCapsule(capsule.sessionId, capsule.capsuleId)}>
          {t("action.remove")}
        </button>
      </div>
      {capsule.humanSummary.trim() !== "" ? <Markdown text={capsule.humanSummary} className={styles.body} /> : null}
      {capsule.technicalHandoff.trim() !== "" ? (
        <details className={styles.handoff}>
          <summary>{t("capsule.handoff")}</summary>
          <Markdown text={capsule.technicalHandoff} className={styles.body} />
        </details>
      ) : null}
      {capsule.touchedFiles.length > 0 ? <p className={styles.files}>{capsule.touchedFiles.join("、")}</p> : null}
    </li>
  );
}

export function CapsulePanel(): JSX.Element {
  const state = useClientState();
  const store = useStore();

  useEffect(() => {
    void store.loadCapsules();
  }, [store, state.activeWorkspaceId]);

  return (
    <div className={styles.panel}>
      <p className={styles.hint}>{t("capsule.howTo")}</p>
      {state.capsules.length === 0 ? (
        <p className={styles.hint}>{t("capsule.none")}</p>
      ) : (
        <ul className={styles.list}>
          {state.capsules.map((capsule) => (
            <CapsuleItem key={`${capsule.sessionId}:${capsule.capsuleId}`} capsule={capsule} />
          ))}
        </ul>
      )}
    </div>
  );
}
