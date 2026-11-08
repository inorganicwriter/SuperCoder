/**
 * 浅色/深色主题。遵循架构设计规范；取值与切换方式对齐 Python 版前端
 * （`js/state.js` 的 `sc_theme` + `<html class="dark">`，默认浅色）。
 *
 * 这里只做纯函数：读写存储、算下一个模式、把类名刷到根元素上。
 * 组件不直接碰 `localStorage` 与 `document`，这样没有 jsdom 也能测。
 */

export type ThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "sc_theme";
export const DARK_CLASS = "dark";

/** 注入点：浏览器里是 localStorage 与 document.documentElement。 */
export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeRoot {
  classList: { toggle(token: string, force?: boolean): boolean };
}

export const DEFAULT_THEME: ThemeMode = "light";

export function parseTheme(value: string | null): ThemeMode {
  return value === "dark" ? "dark" : DEFAULT_THEME;
}

export function readTheme(storage: ThemeStorage): ThemeMode {
  try {
    return parseTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    // 隐私模式/配额异常时读不到存储：按默认浅色走，不要因此白屏。
    return DEFAULT_THEME;
  }
}

export function nextTheme(mode: ThemeMode): ThemeMode {
  return mode === "dark" ? "light" : "dark";
}

export function writeTheme(storage: ThemeStorage, mode: ThemeMode): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 写不进去只意味着下次启动回到默认主题，不值得打断用户。
  }
}

export function applyTheme(root: ThemeRoot, mode: ThemeMode): void {
  root.classList.toggle(DARK_CLASS, mode === "dark");
}
