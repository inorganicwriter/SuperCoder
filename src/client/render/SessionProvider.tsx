// i18n-exempt-file: 开发期断言（只在写错 Provider 嵌套时抛出）
/**
 * 客户端容器。遵循架构设计规范 P2：`object/` 里不放 React，React 只在这里往下出现。
 */

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ClientStore, type ClientState } from "../object/store.js";
import { getLocale, t, type Locale } from "../locale/index.js";

interface SessionContextValue {
  readonly store: ClientStore;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export interface Bootstrap {
  readonly port: number;
  readonly token: string;
  readonly home: string;
  readonly version: string;
  /** 让主进程把原生菜单/对话框切到同一套明暗（Electron 里才有）。 */
  readonly setTheme?: (mode: "light" | "dark") => void;
  /** 打开系统选择文件夹对话框；用户取消返回 null。浏览器里没有这个能力。 */
  readonly pickDirectory?: () => Promise<string | null>;
  /** 用系统浏览器打开链接；只有 Electron 里才有，浏览器调试时为 undefined。 */
  readonly openExternal?: (url: string) => Promise<boolean>;
}

/**
 * 选目录。Electron 里走主进程的原生对话框；浏览器里返回 null，
 * 调用方据此退回到手动输入（而不是弹一个假的"选择器"）。
 */
export async function pickDirectory(): Promise<string | null> {
  const bridge = (globalThis as { supercoder?: Bootstrap }).supercoder;
  if (bridge?.pickDirectory === undefined) return null;
  try {
    return await bridge.pickDirectory();
  } catch {
    return null;
  }
}

/** 有没有原生选目录能力（Electron 里有，浏览器里没有）。 */
export function canPickDirectory(): boolean {
  return (globalThis as { supercoder?: Bootstrap }).supercoder?.pickDirectory !== undefined;
}

export function readBootstrap(): Bootstrap | null {
  const value = (globalThis as { supercoder?: Bootstrap }).supercoder;
  if (value === undefined) return null;
  if (typeof value.port !== "number" || typeof value.token !== "string") return null;
  return value;
}

export function SessionProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const bootstrap = useMemo(() => readBootstrap(), []);
  const store = useMemo(() => {
    if (bootstrap === null) return null;
    return new ClientStore({
      port: bootstrap.port,
      token: bootstrap.token,
      locale: getLocale() as Locale,
    });
  }, [bootstrap]);

  useEffect(() => {
    if (store === null) return;
    store.start();
    return () => store.stop();
  }, [store]);

  if (store === null) {
    return (
      <div style={{ padding: 24, fontFamily: "var(--sc-font)" }}>
        {t("error.title")}: window.supercoder missing — start the app with `pnpm start`, not by opening the file.
      </div>
    );
  }
  return <SessionContext.Provider value={{ store }}>{children}</SessionContext.Provider>;
}

export function useStore(): ClientStore {
  const context = useContext(SessionContext);
  if (context === null) throw new Error("useStore 必须在 SessionProvider 之内使用");
  return context.store;
}

export function useClientState(): ClientState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}
