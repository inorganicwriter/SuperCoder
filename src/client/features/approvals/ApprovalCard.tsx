/**
 * 审批卡片。遵循架构设计规范：写操作必须由人点头，拒绝与失败分开记录。
 */

import { useState } from "react";
import { t } from "../../locale/index.js";
import { Select } from "../../render/Select.js";
import { useStore } from "../../render/SessionProvider.js";
import styles from "./cards.module.css";

/** 与  `approval.respond` 的 remember 取值一致（客户端不引 host 代码）。 */
type RememberScope = "none" | "turn" | "workspace";

export interface ApprovalCardProps {
  readonly callId: string;
  readonly toolName: string;
}

export function ApprovalCard({ callId, toolName }: ApprovalCardProps): JSX.Element {
  const store = useStore();
  const [remember, setRemember] = useState<RememberScope>("none");
  const [sent, setSent] = useState(false);

  const respond = (decision: "allow" | "deny"): void => {
    setSent(true);
    void store.respondApproval(callId, decision, remember);
  };

  return (
    <div className={styles.card} id={`sc-approval-${callId}`}>
      <div className={styles.cardTitle}>{t("approval.title")}</div>
      <div className={styles.cardBody}>
        {t("approval.body")}
        <code className={styles.code}>{toolName}</code>
      </div>
      <div className={styles.cardRow}>
        <div className={styles.checkbox}>
          {t("approval.remember")}
          <div className={styles.rememberSelect}>
            <Select
              value={remember}
              ariaLabel={t("approval.remember")}
              options={[
                { value: "none", label: t("remember.none") },
                { value: "turn", label: t("remember.turn") },
                { value: "workspace", label: t("remember.workspace") },
              ]}
              onChange={(next) => setRemember(next as RememberScope)}
            />
          </div>
        </div>
        <div className={styles.cardActions}>
          <button type="button" disabled={sent} onClick={() => respond("allow")}>
            {t("action.allow")}
          </button>
          <button type="button" disabled={sent} onClick={() => respond("deny")}>
            {t("action.deny")}
          </button>
        </div>
      </div>
    </div>
  );
}
