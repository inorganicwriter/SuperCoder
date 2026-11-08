/**
 * 工作区弹窗（对应 Python 版的 `#workspaceModal`）。
 *
 * 原版只做三件事：列出现有工作区（当前项标记）、填路径添加、移除。
 * 会话列表不在这里 —— 它在左栏「历史对话」里，弹窗里再放一遍会让两处状态互相打脸。
 */

import { useState } from "react";
import { t } from "../../locale/index.js";
import {
  canPickDirectory,
  pickDirectory,
  useClientState,
  useStore,
} from "../../render/SessionProvider.js";
import styles from "./workspaces.module.css";

export function WorkspaceBar(): JSX.Element {
  const state = useClientState();
  const store = useStore();
  const [path, setPath] = useState("");
  const [picking, setPicking] = useState(false);
  const nativePicker = canPickDirectory();

  const pick = async (): Promise<void> => {
    setPicking(true);
    try {
      const picked = await pickDirectory();
      if (picked !== null) await store.addWorkspace(picked);
    } finally {
      setPicking(false);
    }
  };

  const add = (): void => {
    const value = path.trim();
    if (value === "") return;
    setPath("");
    void store.addWorkspace(value);
  };

  return (
    <div className={styles.bar}>
      <section className={styles.section}>
        <h2 className={styles.heading}>{t("nav.workspaces")}</h2>
        {state.workspaces.length === 0 ? (
          <p className={styles.empty}>{t("workspace.none")}</p>
        ) : (
          <ul className={styles.list}>
            {state.workspaces.map((workspace) => (
              <li key={workspace.id} className={styles.row}>
                <button
                  type="button"
                  className={
                    workspace.id === state.activeWorkspaceId ? styles.itemActive : styles.item
                  }
                  onClick={() => void store.selectWorkspace(workspace.id)}
                  title={workspace.path}
                >
                  <span className={styles.name}>{workspace.name}</span>
                  <span className={styles.path}>{workspace.path}</span>
                  {workspace.id === state.activeWorkspaceId ? (
                    <span className={styles.pill}>{t("workspace.active")}</span>
                  ) : null}
                </button>
                <button
                  type="button"
                  className={styles.remove}
                  title={t("workspace.remove")}
                  aria-label={`${t("workspace.remove")}：${workspace.name}`}
                  onClick={() => void store.removeWorkspace(workspace.id)}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M2 2L8 8M8 2L2 8" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.addRow}>
          {nativePicker ? (
            <button type="button" className={styles.pick} onClick={() => void pick()} disabled={picking}>
              {picking ? t("workspace.picking") : t("workspace.pick")}
            </button>
          ) : (
            <>
              <input
                value={path}
                placeholder={t("workspace.path")}
                aria-label={t("workspace.path")}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") add();
                }}
              />
              <button type="button" onClick={add} disabled={path.trim() === ""}>
                {t("workspace.add")}
              </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
