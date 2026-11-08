/**
 * 握手认证。遵循架构设计规范。
 *
 * 三件事全过才收发业务帧：
 * - `Host` 等于 `127.0.0.1:<port>`
 * - `Origin` 同源（浏览器发的是完整 URL，这里剥掉 scheme 再比）
 * - token 用 `timingSafeEqual` 比对，长度不等先短路
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

export const LOOPBACK = "127.0.0.1";

export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 长度不等时先返回 false：`timingSafeEqual` 对不等长会抛。 */
export function tokensEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function normalizeOrigin(origin: string): string {
  return origin
    .trim()
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
    .replace(/\/+$/, "");
}

export interface HandshakeInput {
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly token: string | undefined;
  readonly expectedToken: string;
  readonly port: number;
}

export type HandshakeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function verifyHandshake(input: HandshakeInput): HandshakeResult {
  const expectedHost = `${LOOPBACK}:${input.port}`;
  if (input.host !== expectedHost) {
    return { ok: false, reason: `Host 必须是 ${expectedHost}，实际是 ${JSON.stringify(input.host ?? null)}` };
  }
  if (input.origin === undefined || input.origin === "") {
    return { ok: false, reason: "缺少 Origin 头，拒绝跨进程来源的握手" };
  }
  if (normalizeOrigin(input.origin) !== expectedHost) {
    return { ok: false, reason: `Origin 与 ${expectedHost} 不同源` };
  }
  if (input.token === undefined || input.token === "") {
    return { ok: false, reason: "缺少 token" };
  }
  if (!tokensEqual(input.token, input.expectedToken)) {
    return { ok: false, reason: "token 不匹配" };
  }
  return { ok: true };
}

/** 从 ws 的 URL 里取 token（`/ws?token=...`）。 */
export function tokenFromUrl(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) return undefined;
  const at = rawUrl.indexOf("?");
  if (at < 0) return undefined;
  const params = new URLSearchParams(rawUrl.slice(at + 1));
  return params.get("token") ?? undefined;
}
