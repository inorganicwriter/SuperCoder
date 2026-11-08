/**
 * 客户端状态层：与传输层打交道，不带 React。遵循架构设计规范。
 */

import type { ErrorCode } from "../../shared/protocol/errors.js";

export type ConnectionState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  | { readonly kind: "open"; readonly sessionId: string; readonly lastSeq: number }
  | { readonly kind: "closed"; readonly reason: string; readonly code?: ErrorCode };

export function nextSeqAfter(state: ConnectionState): number {
  return state.kind === "open" ? state.lastSeq + 1 : 1;
}
