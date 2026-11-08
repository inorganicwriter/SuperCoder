/**
 * 文案入口。遵循架构设计规范。
 *
 * 界面只调 `t(key)`；语言存在 localStorage，默认中文。
 * 两个语言文件的键集合由 `pnpm i18n:gate` 比对，缺一个就失败。
 */

import { en } from "./en.js";
import { zhCN, type LocaleKey } from "./zh-CN.js";

export type Locale = "zh-CN" | "en";
export type { LocaleKey };

const STORAGE_KEY = "supercoder.locale";

const TABLES: Record<Locale, Record<LocaleKey, string>> = {
  "zh-CN": zhCN,
  en,
};

let current: Locale = detect();

function detect(): Locale {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved === "zh-CN" || saved === "en") return saved;
  } catch {
    /* localStorage 不可用就按默认 */
  }
  return "zh-CN";
}

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    /* 存不上也不影响本次会话 */
  }
}

export function t(key: LocaleKey): string {
  return TABLES[current][key];
}

export function localeTable(locale: Locale): Record<LocaleKey, string> {
  return TABLES[locale];
}

export { zhCN, en };
