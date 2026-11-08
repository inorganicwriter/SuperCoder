/**
 * 右侧文件栏：文件树 + 预览 + git 变更。只读。
 *
 * 数据来自主进程的三个只读接口（/files/list、/files/read、/git/status），
 * 都要带令牌，路径都被限制在当前工作区根之内。目录懒加载：点开才请求。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../locale/index.js";
import { readBootstrap } from "../../render/SessionProvider.js";
import styles from "./explorer.module.css";

interface FileEntry {
  readonly name: string;
  readonly path: string;
  readonly kind: "dir" | "file";
  readonly size: number;
}

interface Preview {
  readonly path: string;
  readonly size: number;
  readonly content: string;
  readonly truncated: boolean;
  readonly binary: boolean;
}

interface GitChange {
  readonly path: string;
  readonly status: string;
}

interface GitSummary {
  readonly isRepo: boolean;
  readonly branch: string;
  readonly changes: GitChange[];
  readonly error: string | null;
}

type Tab = "files" | "git";

function api(path: string): string {
  const bootstrap = readBootstrap();
  if (bootstrap === null) return "";
  return `http://127.0.0.1:${String(bootstrap.port)}${path}&token=${encodeURIComponent(bootstrap.token)}`;
}

/** 一次目录请求。失败时返回错误说明，不抛。 */
async function loadDirectory(
  workspaceId: string,
  path: string,
): Promise<{ entries: FileEntry[]; error: string | null }> {
  const url = api(`/files/list?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`);
  if (url === "") return { entries: [], error: t("explorer.noBootstrap") };
  try {
    const response = await fetch(url);
    const body = (await response.json()) as { entries?: FileEntry[]; error?: string };
    if (!response.ok || body.error !== undefined) {
      return { entries: [], error: body.error ?? t("explorer.readFailed") };
    }
    return { entries: body.entries ?? [], error: null };
  } catch {
    return { entries: [], error: t("explorer.readFailed") };
  }
}

const WIDTH_KEY = "sc.explorerWidth";
const SPLIT_KEY = "sc.explorerSplit";

/** 预览区占文件栏高度的比例，默认一半。 */
function readSplit(): number {
  try {
    const saved = Number(window.localStorage.getItem(SPLIT_KEY));
    if (Number.isFinite(saved) && saved >= 0.2 && saved <= 0.8) return saved;
  } catch {
    // 读不到就用一半。
  }
  return 0.5;
}
const MIN_WIDTH = 240;
const MAX_WIDTH = 720;

function readWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= MIN_WIDTH && saved <= MAX_WIDTH) return saved;
  } catch {
    // 读不到就用默认宽度。
  }
  return 320;
}

export function FileExplorer({ workspaceId }: { readonly workspaceId: string }): JSX.Element {
  const [width, setWidth] = useState<number>(readWidth);
  const [split, setSplit] = useState<number>(readSplit);
  const panelRef = useRef<HTMLDivElement>(null);

  // 预览区上沿拖动：按指针到面板底部的距离算预览区占比，限制在 20%–80%。
  const startSplit = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const rect = panelRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    let latest = split;
    const onMove = (move: PointerEvent): void => {
      latest = Math.min(0.8, Math.max(0.2, (rect.bottom - move.clientY) / rect.height));
      setSplit(latest);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      try {
        window.localStorage.setItem(SPLIT_KEY, latest.toFixed(3));
      } catch {
        // 存不了只影响下次打开。
      }
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // 指针在窗口外松开、或者拖动被系统打断时，window 上的 pointerup 收不到：
    // 监听 window 事件并处理 pointercancel，防止拖拽过程中指针丢失导致样式卡住。
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };
  const [tab, setTab] = useState<Tab>("files");

  // 左边缘拖动调宽：按下时记住起点，移动时按位移算新宽度，松开时写回 localStorage。
  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    const onMove = (move: PointerEvent): void => {
      latest = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (startX - move.clientX)));
      setWidth(latest);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      try {
        window.localStorage.setItem(WIDTH_KEY, String(Math.round(latest)));
      } catch {
        // 存不了只影响下次打开的默认宽度。
      }
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // 指针在窗口外松开、或者拖动被系统打断时，window 上的 pointerup 收不到：
    // 光靠它会让 cursor / user-select 卡住，所以再挂一份，并兜住 pointercancel。
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };
  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, FileEntry[]>>({});
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [git, setGit] = useState<GitSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    const root = await loadDirectory(workspaceId, "");
    setRootEntries(root.entries);
    setError(root.error);
    setExpanded({});
    setOpenDirs({});
    const gitUrl = api(`/git/status?workspaceId=${encodeURIComponent(workspaceId)}`);
    if (gitUrl === "") return;
    try {
      const response = await fetch(gitUrl);
      if (response.ok) setGit((await response.json()) as GitSummary);
    } catch {
      // git 状态读不到不影响看文件，这里静默。
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleDir = async (entry: FileEntry): Promise<void> => {
    if (openDirs[entry.path] === true) {
      setOpenDirs({ ...openDirs, [entry.path]: false });
      return;
    }
    if (expanded[entry.path] === undefined) {
      const loaded = await loadDirectory(workspaceId, entry.path);
      if (loaded.error !== null) {
        setError(loaded.error);
        return;
      }
      setExpanded({ ...expanded, [entry.path]: loaded.entries });
    }
    setOpenDirs({ ...openDirs, [entry.path]: true });
  };

  const openFile = async (entry: FileEntry): Promise<void> => {
    const url = api(`/files/read?workspaceId=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(entry.path)}`);
    if (url === "") return;
    try {
      const response = await fetch(url);
      const body = (await response.json()) as Preview & { error?: string };
      if (!response.ok || body.error !== undefined) {
        setError(body.error ?? t("explorer.readFailed"));
        return;
      }
      setPreview(body);
      setError(null);
    } catch {
      setError(t("explorer.readFailed"));
    }
  };

  const changedPaths = new Set((git?.changes ?? []).map((change) => change.path));

  const renderEntries = (entries: readonly FileEntry[], depth: number): JSX.Element[] =>
    entries.map((entry) => {
      const marker = changedPaths.has(entry.path) ? "●" : "";
      if (entry.kind === "dir") {
        return (
          <div key={entry.path}>
            <button
              type="button"
              className={styles.row}
              style={{ paddingLeft: `${String(8 + depth * 12)}px` }}
              aria-expanded={openDirs[entry.path] === true}
              onClick={() => void toggleDir(entry)}
            >
              <span className={styles.caret}>{openDirs[entry.path] === true ? "▾" : "▸"}</span>
              <span className={styles.name}>{entry.name}</span>
            </button>
            {openDirs[entry.path] === true
              ? renderEntries(expanded[entry.path] ?? [], depth + 1)
              : null}
          </div>
        );
      }
      return (
        <button
          key={entry.path}
          type="button"
          className={
            preview?.path === entry.path ? `${styles.row} ${styles.rowActive}` : styles.row
          }
          style={{ paddingLeft: `${String(8 + depth * 12)}px` }}
          onClick={() => void openFile(entry)}
        >
          <span className={styles.name}>{entry.name}</span>
          {marker === "" ? null : <span className={styles.mark}>{marker}</span>}
        </button>
      );
    });

  return (
    <div ref={panelRef} className={styles.panel} style={{ width }}>
      <div
        className={styles.resizer}
        role="separator"
        aria-orientation="vertical"
        onPointerDown={startResize}
        onDoubleClick={() => { setWidth(320); try { window.localStorage.removeItem(WIDTH_KEY); } catch { /* 忽略 */ } }}
      />
      <div className={styles.head}>
        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "files"}
            className={tab === "files" ? `${styles.tab} ${styles.tabOn}` : styles.tab}
            onClick={() => setTab("files")}
          >
            {t("explorer.files")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "git"}
            className={tab === "git" ? `${styles.tab} ${styles.tabOn}` : styles.tab}
            onClick={() => setTab("git")}
          >
            {t("explorer.git")}
            {git === null || git.changes.length === 0 ? null : (
              <span className={styles.count}>{git.changes.length}</span>
            )}
          </button>
        </div>
        <button
          type="button"
          className={styles.refresh}
          title={t("explorer.refresh")}
          aria-label={t("explorer.refresh")}
          onClick={() => void refresh()}
        >
          ↻
        </button>
      </div>

      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {tab === "files" ? (
        <div className={styles.tree}>{renderEntries(rootEntries, 0)}</div>
      ) : (
        <div className={styles.tree}>
          {git === null ? (
            <p className={styles.empty}>{t("explorer.gitLoading")}</p>
          ) : !git.isRepo ? (
            <p className={styles.empty}>{t("explorer.notRepo")}</p>
          ) : (
            <>
              <p className={styles.branch}>
                {t("explorer.branch")}：{git.branch === "" ? "—" : git.branch}
              </p>
              {git.changes.length === 0 ? (
                <p className={styles.empty}>{t("explorer.noChanges")}</p>
              ) : (
                git.changes.map((change) => (
                  <button
                    key={change.path}
                    type="button"
                    className={styles.row}
                    onClick={() =>
                      void openFile({ name: change.path, path: change.path, kind: "file", size: 0 })
                    }
                  >
                    <span className={styles.status}>{change.status}</span>
                    <span className={styles.name}>{change.path}</span>
                  </button>
                ))
              )}
            </>
          )}
        </div>
      )}

      {preview === null ? null : (
        <div className={styles.preview} style={{ height: `${String(Math.round(split * 100))}%` }}>
          <div
            className={styles.splitter}
            role="separator"
            aria-orientation="horizontal"
            onPointerDown={startSplit}
            onDoubleClick={() => { setSplit(0.5); try { window.localStorage.removeItem(SPLIT_KEY); } catch { /* 忽略 */ } }}
          />
          <div className={styles.previewHead}>
            <span className={styles.previewPath}>{preview.path}</span>
            <span className={styles.previewSize}>{Math.max(1, Math.round(preview.size / 1024))} KB</span>
            <button
              type="button"
              className={styles.refresh}
              onClick={() => setPreview(null)}
              aria-label={t("action.close")}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                    <path d="M2 2L8 8M8 2L2 8" />
                  </svg>
            </button>
          </div>
          {preview.binary ? (
            <p className={styles.empty}>{t("explorer.binary")}</p>
          ) : (
            <pre className={styles.code}>{preview.content}</pre>
          )}
          {preview.truncated ? <p className={styles.empty}>{t("explorer.truncated")}</p> : null}
        </div>
      )}
    </div>
  );
}
