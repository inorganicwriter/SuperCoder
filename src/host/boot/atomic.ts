/**
 * 原子写与容错读。遵循架构设计规范。
 *
 * 索引与配置文件都是"可丢的缓存"：写走 tmp + rename，读失败就当没有。
 * 会话日志采用追加写入与 fsync 机制，不使用全量原子覆盖，见 session/log.ts。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** 写 `.tmp` 再 rename：崩溃时要么是旧内容，要么是新内容，不会半截。 */
export function writeFileAtomic(file: string, content: string): void {
  ensureDir(dirname(file));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** 读 JSON；不存在或解析失败都返回 null（调用方按"缓存失效"处理）。 */
export function readJsonIfPresent(file: string): unknown | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export function readTextIfPresent(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
