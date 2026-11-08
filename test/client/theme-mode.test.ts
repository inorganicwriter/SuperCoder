/**
 * 主题切换的纯函数。遵循架构设计规范；行为对齐 Python 版前端的 `sc_theme`。
 *
 * 这些用例不需要 jsdom：存储与根元素都按接口注入。
 */

import { describe, expect, it } from "vitest";
import {
  DARK_CLASS,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  nextTheme,
  parseTheme,
  readTheme,
  writeTheme,
  type ThemeRoot,
  type ThemeStorage,
} from "../../src/client/theme/mode.js";

function fakeStorage(initial: string | null = null, options: { throwOnRead?: boolean; throwOnWrite?: boolean } = {}): {
  storage: ThemeStorage;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  if (initial !== null) values.set(THEME_STORAGE_KEY, initial);
  return {
    values,
    storage: {
      getItem(key: string): string | null {
        if (options.throwOnRead === true) throw new Error("读存储失败");
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string): void {
        if (options.throwOnWrite === true) throw new Error("写存储失败");
        values.set(key, value);
      },
    },
  };
}

describe("Theme Mode", () => {
  it("defaults to light theme unless dark is explicitly stored", () => {
    expect(DEFAULT_THEME).toBe("light");
    expect(parseTheme(null)).toBe("light");
    expect(parseTheme("")).toBe("light");
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("DARK")).toBe("light");
  });

  it("falls back to light theme when stored value is missing or unrecognized", () => {
    expect(readTheme(fakeStorage().storage)).toBe("light");
    expect(readTheme(fakeStorage("dark").storage)).toBe("dark");
    expect(readTheme(fakeStorage("purple").storage)).toBe("light");
  });

  it("handles storage read exceptions gracefully and falls back to light", () => {
    expect(readTheme(fakeStorage("dark", { throwOnRead: true }).storage)).toBe("light");
  });

  it("toggling theme back and forth is symmetrical", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });

  it("uses consistent storage key and suppresses write errors", () => {
    const { storage, values } = fakeStorage();
    writeTheme(storage, "dark");
    expect(values.get(THEME_STORAGE_KEY)).toBe("dark");
    writeTheme(storage, "light");
    expect(values.get(THEME_STORAGE_KEY)).toBe("light");
    expect(() => writeTheme(fakeStorage(null, { throwOnWrite: true }).storage, "dark")).not.toThrow();
  });

  it("updates root class list adding 'dark' for dark theme and removing for light", () => {
    const calls: Array<{ token: string; force: boolean | undefined }> = [];
    const root: ThemeRoot = {
      classList: {
        toggle(token: string, force?: boolean): boolean {
          calls.push({ token, force });
          return force ?? false;
        },
      },
    };
    applyTheme(root, "dark");
    applyTheme(root, "light");
    expect(calls).toEqual([
      { token: DARK_CLASS, force: true },
      { token: DARK_CLASS, force: false },
    ]);
  });
});
