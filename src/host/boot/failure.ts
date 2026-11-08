/**
 * 可预期的 RPC 失败封装。遵循架构设计规范。
 */

import { ERROR_HINTS, type ErrorCode } from "../../shared/protocol/errors.js";

export class RpcFailure extends Error {
  readonly code: ErrorCode;
  /**
   * 已经写进日志、但落盘确认失败的那条事件（只有 `Log.append` 会填）。
   *
   * 它不是线上字段：RPC 只把 code/message 发出去。它存在的理由是
   * "日志里已经有了这条事件，内存投影也必须推进"，否则界面与磁盘从此分叉。
   */
  readonly writtenEvent?: unknown;

  constructor(code: ErrorCode, message: string, writtenEvent?: unknown) {
    super(message);
    this.name = "RpcFailure";
    this.code = code;
    if (writtenEvent !== undefined) this.writtenEvent = writtenEvent;
  }

  /** 复制一份并带上"已经写进去的那条事件"：code 与 message 原样不动。 */
  carrying(writtenEvent: unknown): RpcFailure {
    return new RpcFailure(this.code, this.message, writtenEvent);
  }

  /**
   * 构造标准 RpcFailure。若未提供具体 detail 则采用该错误码的默认错误提示。
   */
  static of(code: ErrorCode, detail?: string): RpcFailure {
    const text = detail && detail.trim() !== "" ? detail : ERROR_HINTS[code];
    return new RpcFailure(code, text);
  }
}

export function fail(code: ErrorCode, detail?: string): never {
  throw RpcFailure.of(code, detail);
}

export function isRpcFailure(error: unknown): error is RpcFailure {
  return error instanceof RpcFailure;
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
