/**
 * 统一的结构化日志。遵循架构设计规范（pino）。
 *
 * 所有日志条目都带上下文字段；脱敏规则在这里集中一次。
 */

import { pino } from "pino";

export const REDACT_PATHS = [
  "token",
  "*.token",
  "authorization",
  "*.authorization",
  "cookie",
  "*.cookie",
  "apiKey",
  "*.apiKey",
  "*.api_key",
  "secret",
  "*.secret",
  "password",
  "*.password",
];

export type Logger = pino.Logger;

export interface LoggerOptions {
  readonly level?: string;
  readonly sessionId?: string;
  readonly bindings?: Record<string, string>;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const base: Record<string, string> = { ...options.bindings };
  if (options.sessionId !== undefined) base["sessionId"] = options.sessionId;
  return pino({
    level: options.level ?? process.env["SUPERCODER_LOG_LEVEL"] ?? "info",
    base,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  });
}

/** 测试与 bench 用：全部丢掉。 */
export function silentLogger(): Logger {
  return pino({ level: "silent" });
}
