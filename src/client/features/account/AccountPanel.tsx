/**
 * 账户分区：登录状态、Google 登录、版本与数据目录。
 *
 * 这个版本没有服务端，登进来的身份只用来在这台机器上显示"你是谁"，
 * 不会上传任何东西。Google 登录走 OAuth 2.0 授权码 + PKCE，客户端 ID 由用户自己建。
 */

import { useState } from "react";
import { t } from "../../locale/index.js";
import { readBootstrap } from "../../render/SessionProvider.js";
import { readAccount, readClientId, writeAccount, writeClientId, type Account } from "./account.js";
import { signInWithGoogle } from "./google.js";
import styles from "./account.module.css";

export function AccountPanel(): JSX.Element {
  const storage = window.localStorage;
  const [account, setAccount] = useState<Account | null>(() => readAccount(storage));
  const [clientId, setClientId] = useState<string>(() => readClientId(storage));
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const bootstrap = readBootstrap();

  const signIn = async (): Promise<void> => {
    setError(null);
    const id = clientId.trim();
    if (id === "") {
      setError(t("account.needClientId"));
      return;
    }
    writeClientId(storage, id);
    try {
      const result = await signInWithGoogle({ clientId: id, onStage: setStage });
      const next: Account = { ...result, provider: "google" };
      writeAccount(storage, next);
      setAccount(next);
      setStage(null);
    } catch (failure) {
      setStage(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const signOut = (): void => {
    writeAccount(storage, null);
    setAccount(null);
    setError(null);
    setStage(null);
  };

  return (
    <div className={styles.stack}>
      <div className={styles.profile}>
        {account?.picture !== null && account?.picture !== undefined ? (
          <img className={styles.avatar} src={account.picture} alt="" />
        ) : (
          <span className={styles.avatar}>
            {(account?.name ?? "").trim().slice(0, 1).toUpperCase() || "U"}
          </span>
        )}
        <div className={styles.identity}>
          <span className={styles.name}>{account?.name ?? t("account.signedOut")}</span>
          {account === null ? null : (
            <span className={styles.meta}>
              {account.provider === "google" ? `Google · ${account.email}` : t("account.providerLocal")}
            </span>
          )}
        </div>
        {account === null ? null : (
          <button type="button" className={styles.ghost} onClick={signOut}>
            {t("account.signOut")}
          </button>
        )}
      </div>

      {account === null ? (
          <div className={styles.field}>
            <span className={styles.label}>{t("account.google")}</span>
            <div className={styles.inline}>
              <input
                value={clientId}
                placeholder={t("account.clientIdPlaceholder")}
                onChange={(event) => setClientId(event.target.value)}
              />
              <button type="button" className={styles.primary} onClick={() => void signIn()}>
                {t("account.signInGoogle")}
              </button>
            </div>
            {stage === null ? null : <p className={styles.stage}>{stage}</p>}
            {error === null ? null : (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
          </div>
      ) : null}

      <dl className={styles.kv}>
        <div className={styles.kvRow}>
          <dt className={styles.kvLabel}>{t("settings.version")}</dt>
          <dd className={styles.kvValue}>{bootstrap?.version ?? "—"}</dd>
        </div>
        <div className={styles.kvRow}>
          <dt className={styles.kvLabel}>{t("settings.dataDir")}</dt>
          <dd className={`${styles.kvValue} ${styles.mono}`}>{bootstrap?.home ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}
