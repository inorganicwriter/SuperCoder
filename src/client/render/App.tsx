/**
 * 主界面骨架：照 Python 版那套设计重画（左栏导航 + 中间对话 + 右侧抽屉），
 * 但组件、状态与类型全部用现在的 TypeScript 栈。
 */

import { useEffect, useState } from "react";
import { useClientState, useStore, readBootstrap } from "./SessionProvider.js";
import { Logo } from "./Logo.js";
import { applyTheme, writeTheme, type ThemeMode } from "../theme/mode.js";
import { Conversation } from "../features/conversation/Conversation.js";
import { FileExplorer } from "../features/explorer/FileExplorer.js";
import { Composer } from "../features/composer/Composer.js";
import { WorkspaceBar } from "../features/workspaces/WorkspaceBar.js";
import { InboxPanel } from "../features/inbox/InboxPanel.js";
import type { InboxItem } from "../../shared/session/derive.js";
import { userModels } from "../../shared/domain/model.js";
import { TaskPanel } from "../features/tasks/TaskPanel.js";
import { CapsulePanel } from "../features/capsules/CapsulePanel.js";
import { getLocale, setLocale, t, type Locale } from "../locale/index.js";
import { Modal } from "./Modal.js";
import type { SettingsSection } from "../features/settings/SettingsModal.js";
import { SettingsModal } from "../features/settings/SettingsModal.js";
import { SearchBox } from "../features/search/SearchBox.js";
import styles from "./shell.module.css";

/** 右侧抽屉：老界面的抽屉只有"上下文"和"任务详情"两页。 */
type DrawerTab = "capsules" | "tasks";

const DRAWER_TABS: ReadonlyArray<{ id: DrawerTab; key: Parameters<typeof t>[0] }> = [
  { id: "capsules", key: "nav.capsules" },
  { id: "tasks", key: "nav.tasks" },
];

/** 独立弹窗只剩工作区；MCP 并入了设置。 */
type ModalTab = "workspace";

const MODAL_TITLE: Readonly<Record<ModalTab, Parameters<typeof t>[0]>> = {
  workspace: "nav.workspaces",
};

const STATUS_KEY = {
  connecting: "status.connecting",
  open: "status.open",
  closed: "status.closed",
} as const;

const STATUS_CLASS = {
  connecting: "dotConnecting",
  open: "dotOpen",
  closed: "dotClosed",
} as const;

/** 跳转后闪一下描边，指出落在哪张卡片上。 */
function flash(element: HTMLElement): void {
  element.classList.remove("sc-flash");
  // 读一次布局，连续点同一条也能重放动画。
  void element.offsetWidth;
  element.classList.add("sc-flash");
  window.setTimeout(() => element.classList.remove("sc-flash"), 2600);
}

export function App({ initialTheme = "light" }: { readonly initialTheme?: ThemeMode }): JSX.Element {
  const state = useClientState();
  const store = useStore();
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [modal, setModal] = useState<ModalTab | null>(null);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // 同一个对话框承担三种用途：新建（填名字）、重命名（预填当前标题）、删除（只确认）。
  const [chatDialog, setChatDialog] = useState<{
    readonly mode: "create" | "rename" | "delete";
    readonly sessionId: string;
    readonly value: string;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  // 会话行菜单：位置在打开时按按钮矩形计算一次；fixed 定位，滚动时不需要重算。
  const [rowMenu, setRowMenu] = useState<{
    readonly sessionId: string;
    readonly title: string;
    readonly top: number;
    readonly left: number;
  } | null>(null);
  // 已读的"结果未知"通知：只影响通知列表，任务本身仍在对话和任务面板里。
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(window.localStorage.getItem("sc.dismissedNotices") ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const [locale, setLocaleState] = useState<Locale>(getLocale());
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [explorerOpen, setExplorerOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("sc.explorerOpen") === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    applyTheme(document.documentElement, theme);
    writeTheme(window.localStorage, theme);
    readBootstrap()?.setTheme?.(theme);
  }, [theme]);

  // 老界面的 Ctrl K（Mac 上 ⌘K）。放在 window 上，输入框里也能唤出。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // 菜单是独立的 fixed 浮层，不在弹窗组件内，Esc 需要在窗口级别处理。
  useEffect(() => {
    if (rowMenu === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setRowMenu(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [rowMenu]);

  const activeWorkspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId);
  const activeSession = state.sessions.find((item) => item.sessionId === state.activeSessionId);
  // 待处理事项里已包含结果未知的任务，不要再另外拼接一次。
  const notices = (state.view?.pending ?? []).filter((item) => !(item.kind === "task-unknown" && dismissed.has(item.id)));
  const pickNotice = (item: InboxItem): void => {
    setNotifOpen(false);
    // 每类通知都有对应的定位目标：审批与提问在对话末尾的待处理区，结果未知在它的任务卡片上。
    const anchor =
      item.kind === "approval"
        ? `sc-approval-${item.id}`
        : item.kind === "question"
          ? `sc-question-${item.id}`
          : `sc-task-${item.id}`;
    // 审批与提问找不到卡片时退回待处理区；结果未知的任务和待处理区无关，找不到就开任务面板。
    const target = document.getElementById(anchor) ?? (item.kind === "task-unknown" ? null : document.getElementById("sc-pending"));
    if (target === null) {
      // 目标不在当前视图（例如已被折叠）时，打开任务面板，避免点击没有反馈。
      if (item.kind === "task-unknown") setDrawer("tasks");
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    flash(target);
  };
  const dismissNotice = (item: InboxItem): void => {
    const next = new Set(dismissed).add(item.id);
    setDismissed(next);
    try {
      window.localStorage.setItem("sc.dismissedNotices", JSON.stringify([...next].slice(-500)));
    } catch {
      // 写入失败只影响重启后的已读状态。
    }
  };

  const openDrawer = (tab: DrawerTab): void => {
    setModal(null);
    setDrawer((current) => (current === tab ? null : tab));
  };

  const openSettings = (section: SettingsSection): void => {
    setModal(null);
    setSettings((current) => (current === section ? null : section));
  };

  const openModal = (tab: ModalTab): void => {
    setDrawer(null);
    setModal((current) => (current === tab ? null : tab));
  };

  const hasWorkspace = activeWorkspace !== undefined;
  const hasSession = state.activeSessionId !== null;

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandMark}>
            <Logo />
          </span>
          {t("app.name")}
        </div>

        <button
          type="button"
          className={styles.newChat}
          disabled={!hasWorkspace || state.busy}
          onClick={() => setChatDialog({ mode: "create", sessionId: "", value: "" })}
        >
          <span className={styles.newChatPlus} aria-hidden="true">+</span>
          {t("nav.newChat")}
        </button>

        <button type="button" className={styles.ghostAction} onClick={() => setSearchOpen(true)}>
          {t("search.title")}
          <span className={styles.count}>Ctrl K</span>
        </button>

        <nav className={styles.nav}>
          <button type="button" className={styles.navItem} onClick={() => openModal("workspace")}>
            <span>{t("nav.workspaces")}</span>
            <span className={styles.count}>{activeWorkspace?.name ?? t("nav.none")}</span>
          </button>
          <button type="button" className={styles.navItem} onClick={() => openDrawer("capsules")}>
            <span>{t("nav.sharedContext")}</span>
            <span className={styles.count}>{state.capsules.length}</span>
          </button>
          <button type="button" className={styles.navItem} onClick={() => openSettings("agents")}>
            <span>{t("nav.agents")}</span>
            <span className={styles.count}>{state.agents.filter((agent) => agent.installed && agent.level !== 4).length}</span>
          </button>
          <button type="button" className={styles.navItem} onClick={() => openSettings("models")}>
            <span>{t("nav.modelList")}</span>
            {/* 与模型面板同一份集合：老配置里残存的离线档案不算数。 */}
            <span className={styles.count}>{userModels(state.models).length}</span>
          </button>
          <button type="button" className={styles.navItem} onClick={() => openSettings("mcp")}>
            <span>{t("nav.mcpService")}</span>
            <span className={styles.count}>{state.servers.length}</span>
          </button>
        </nav>

        <div className={styles.historyHead}>
          <span>{t("nav.history")}</span>
          <button
            type="button"
            className={styles.historyClear}
            disabled={!hasSession}
            onClick={() => setDrawer("tasks")}
          >
            {t("nav.tasks")}
          </button>
        </div>

        <div className={styles.chatList}>
          {state.sessions.length === 0 ? (
            <div className={styles.emptyHint}>{t("nav.noChat")}</div>
          ) : (
            state.sessions.map((session) => (
              <div key={session.sessionId} className={styles.chatRowWrap}>
                <button
                  type="button"
                  className={
                    session.sessionId === state.activeSessionId
                      ? `${styles.chatRow} ${styles.chatRowActive}`
                      : styles.chatRow
                  }
                  onClick={() => void store.selectSession(session.sessionId)}
                >
                  <span className={styles.chatTitle}>{session.title}</span>
                </button>
                <button
                  type="button"
                  className={styles.chatMore}
                  title={t("chat.more")}
                  aria-label={t("chat.more")}
                  aria-haspopup="menu"
                  aria-expanded={rowMenu?.sessionId === session.sessionId}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    // 菜单下方空间不足时翻到行的上方。
                    const below = rect.bottom + 4;
                    setRowMenu({
                      sessionId: session.sessionId,
                      title: session.title,
                      top: below + 76 > window.innerHeight ? Math.max(8, rect.top - 80) : below,
                      left: Math.max(8, rect.right - 140),
                    });
                  }}
                >
                  ⋯
                </button>
              </div>
            ))
          )}
        </div>


        <button
          type="button"
          className={styles.sidebarFoot}
          onClick={() => openSettings("account")}
          aria-label={t("nav.account")}
        >
          <span className={styles.avatar}>U</span>
          <span>{t("nav.account")}</span>
        </button>

      </aside>

      <main className={styles.main}>
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <button type="button" className={styles.workspaceChip} onClick={() => openModal("workspace")}>
              {hasWorkspace ? activeWorkspace.name : t("workspace.none")}
            </button>
            <div className={styles.pickerWrap}>
              <button
                type="button"
                className={styles.chatPicker}
                disabled={state.sessions.length === 0}
                aria-expanded={pickerOpen}
                aria-label={t("chat.picker")}
                onClick={() => setPickerOpen((open) => !open)}
              >
                {activeSession?.title ?? t("nav.noChat")}
                <span className={styles.pickerCaret}>▾</span>
              </button>
              {pickerOpen ? (
                <>
                  <div className={styles.pickerBackdrop} onClick={() => setPickerOpen(false)} />
                  <ul className={styles.pickerMenu} aria-label={t("chat.picker")}>
                    {state.sessions.map((session) => (
                      <li key={session.sessionId}>
                        <button
                          type="button"
                          className={
                            session.sessionId === state.activeSessionId
                              ? `${styles.pickerItem} ${styles.pickerItemActive}`
                              : styles.pickerItem
                          }
                          onClick={() => {
                            setPickerOpen(false);
                            void store.selectSession(session.sessionId);
                          }}
                        >
                          {session.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </div>
          <div className={styles.headerRight}>
            <div className={styles.notifWrap}>
              <button
                type="button"
                className={styles.iconButton}
                aria-expanded={notifOpen}
                onClick={() => setNotifOpen((open) => !open)}
              >
                {t("nav.pending")}
                {notices.length === 0 ? null : (
                  <span className={styles.notifBadge}>{notices.length}</span>
                )}
              </button>
              {notifOpen ? (
                <>
                  <div className={styles.pickerBackdrop} onClick={() => setNotifOpen(false)} />
                  <div className={styles.notifPopover} role="dialog" aria-label={t("nav.pending")}>
                    <InboxPanel items={notices} onPick={pickNotice} onDismiss={dismissNotice} />
                  </div>
                </>
              ) : null}
            </div>
            <button
              type="button"
              className={styles.iconButton}
              aria-pressed={explorerOpen}
              onClick={() => {
                const next = !explorerOpen;
                setExplorerOpen(next);
                try {
                  window.localStorage.setItem("sc.explorerOpen", next ? "1" : "0");
                } catch {
                  // 写入失败只影响下次启动的默认状态。
                }
              }}
            >
              {t("explorer.title")}
            </button>
            <span className={`${styles.dot} ${styles[STATUS_CLASS[state.status]]}`} title={state.statusDetail ?? ""} />
            <span className={styles.count}>{t(STATUS_KEY[state.status])}</span>
          </div>
        </header>

        {state.error !== null && settings === null ? (
          <div className={styles.notice} role="alert">
            <span>
              <strong>{t("error.title")}：</strong>
              {state.error}
            </span>
            <button type="button" className={styles.iconButton} onClick={() => store.dismissError()}>
              {t("action.close")}
            </button>
          </div>
        ) : null}

        {notice !== null ? (
          <div className={styles.notice}>
            <span>{notice}</span>
            <button type="button" className={styles.iconButton} onClick={() => setNotice(null)}>
              {t("action.close")}
            </button>
          </div>
        ) : null}

        <div className={styles.bodyRow}>
          <div className={styles.column}>
            <div className={styles.scroll}>
              {!hasWorkspace ? (
                <div className={styles.noneHint}>{t("workspace.none")}</div>
              ) : !hasSession ? (
                <div className={styles.hero}>
                  <h1 className={styles.heroTitle}>{t("hero.title")}</h1>
                  <p className={styles.heroHint}>{t("hero.hint")}</p>
                  <div className={styles.heroComposer}>
                    <Composer onOpenModels={() => openSettings("models")} onOpenWorkspace={() => openModal("workspace")} />
                  </div>
                </div>
              ) : (
                <Conversation />
              )}
            </div>

            {hasWorkspace && hasSession ? (
              <div className={styles.docked}>
                <Composer onOpenModels={() => openSettings("models")} onOpenWorkspace={() => openModal("workspace")} />
              </div>
            ) : null}
          </div>

          {explorerOpen && activeWorkspace !== undefined ? (
            <FileExplorer workspaceId={activeWorkspace.id} />
          ) : null}
        </div>

        {drawer !== null ? (
          <section className={styles.drawer} aria-label={t("drawer.title")}>
            <div className={styles.drawerHead}>
              <h2 className={styles.drawerTitle}>{t("drawer.title")}</h2>
              <button type="button" className={styles.iconButton} onClick={() => setDrawer(null)}>
                {t("action.close")}
              </button>
            </div>
            <div className={styles.drawerTabs}>
              {DRAWER_TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={
                    item.id === drawer ? `${styles.drawerTab} ${styles.drawerTabActive}` : styles.drawerTab
                  }
                  onClick={() => setDrawer(item.id)}
                >
                  {t(item.key)}
                </button>
              ))}
            </div>
            <div className={styles.drawerBody}>
              {drawer === "capsules" ? <CapsulePanel /> : null}
              {drawer === "tasks" ? <TaskPanel /> : null}
            </div>
          </section>
        ) : null}
      </main>

      {rowMenu === null ? null : (
        <>
          <div className={styles.menuBackdrop} onClick={() => setRowMenu(null)} />
          <div className={styles.rowMenu} style={{ top: rowMenu.top, left: rowMenu.left }} role="menu">
            <button
              type="button"
              role="menuitem"
              className={styles.rowMenuItem}
              onClick={() => {
                const { sessionId, title } = rowMenu;
                setRowMenu(null);
                setChatDialog({ mode: "rename", sessionId, value: title });
              }}
            >
              {t("action.rename")}
            </button>
            <button
              type="button"
              role="menuitem"
              className={`${styles.rowMenuItem} ${styles.rowMenuItemDanger}`}
              onClick={() => {
                const { sessionId, title } = rowMenu;
                setRowMenu(null);
                setChatDialog({ mode: "delete", sessionId, value: title });
              }}
            >
              {t("action.delete")}
            </button>
          </div>
        </>
      )}

      {chatDialog !== null && chatDialog.mode === "delete" ? (
        <Modal title={t("chat.dialogDelete")} onClose={() => setChatDialog(null)}>
          <div className={styles.chatForm}>
            <p className={styles.chatFormHint}>{t("chat.deleteBody").replace("{title}", () => chatDialog.value)}</p>
            <div className={styles.chatFormActions}>
              <button type="button" className={styles.ghostAction} onClick={() => setChatDialog(null)}>
                {t("action.cancel")}
              </button>
              <button
                type="button"
                className={styles.dangerAction}
                disabled={deleting}
                onClick={() => {
                  if (deleting) return;
                  setDeleting(true);
                  void (async () => {
                    // 失败时留在弹窗里：错误显示在设置/主界面上，用户可以再点一次。
                    try {
                      if (await store.deleteSession(chatDialog.sessionId)) setChatDialog(null);
                    } finally {
                      setDeleting(false);
                    }
                  })();
                }}
              >
                {t("action.delete")}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}

      {chatDialog === null || chatDialog.mode === "delete" ? null : (
        <Modal
          title={chatDialog.mode === "create" ? t("chat.dialogCreate") : t("chat.dialogRename")}
          onClose={() => setChatDialog(null)}
        >
          <form
            className={styles.chatForm}
            onSubmit={(event) => {
              event.preventDefault();
              const value = chatDialog.value.trim();
              void (async () => {
                if (chatDialog.mode === "create") {
                  await store.createSession();
                  if (value !== "") await store.renameSession(value);
                } else {
                  await store.renameSession(value, chatDialog.sessionId);
                }
                setChatDialog(null);
              })();
            }}
          >
            <label className={styles.chatFormLabel} htmlFor="sc-chat-name">
              {t("chat.name")}
            </label>
            <input
              id="sc-chat-name"
              className={styles.chatFormInput}
              value={chatDialog.value}
              placeholder={t("chat.namePlaceholder")}
              autoFocus
              onChange={(event) =>
                setChatDialog({ ...chatDialog, value: event.currentTarget.value })
              }
            />
            <div className={styles.chatFormActions}>
              <button type="button" className={styles.ghostAction} onClick={() => setChatDialog(null)}>
                {t("action.cancel")}
              </button>
              <button type="submit" className={styles.primaryAction}>
                {chatDialog.mode === "create" ? t("action.create") : t("action.save")}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {searchOpen ? (
        <Modal title={t("search.title")} onClose={() => setSearchOpen(false)}>
          <SearchBox
            onPick={(sessionId) => {
              setSearchOpen(false);
              void store.selectSession(sessionId);
            }}
          />
        </Modal>
      ) : null}

      {settings === null ? null : (
        <Modal title={t("settings.title")} onClose={() => setSettings(null)} wide>
          <SettingsModal
            section={settings}
            onSection={setSettings}
            theme={theme}
            onTheme={setTheme}
            locale={locale}
            onLocale={(next) => {
              setLocale(next);
              setLocaleState(next);
            }}
          />
        </Modal>
      )}

      {modal === null ? null : (
        <Modal title={t(MODAL_TITLE[modal])} onClose={() => setModal(null)}>
          <WorkspaceBar />
        </Modal>
      )}
    </div>
  );
}
