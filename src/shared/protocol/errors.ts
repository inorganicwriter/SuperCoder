/**
 * RPC 错误码。遵循架构设计规范。
 *
 * 约定：每个错误码都要带可执行提示，告诉用户下一步做什么。
 * `internal` 之外的提示放进 message 字段。
 */

import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "invalid_params", // 参数不符 zod
  "not_found", // 会话 / 任务 / 请求不存在
  "conflict", // 乐观并发失败（rev 不符）
  "busy", // 违反单写者
  "denied", // 审批拒绝或策略禁止
  "unsupported", // 该 provider 不支持此能力
  "provider_failed", // 外部 agent 失败
  "storage_failed", // 磁盘写入失败
  "shape_mismatch", // 字段守卫拒绝
  "internal", // 未预期的内部错误
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/**
 * 每个错误码配一句可执行提示。抛错时必须带上它，而不是只说"失败了"。
 */
export const ERROR_HINTS: Readonly<Record<ErrorCode, string>> = {
  invalid_params: "请求参数不合法，请检查参数后重试。",
  not_found: "请求的目标对象不存在或已被删除。",
  conflict: "状态版本冲突，请刷新后重试。",
  busy: "当前操作正在进行中，请稍候再试。",
  denied: "操作被拒绝或未获得必要权限。",
  unsupported: "当前执行者不支持该项能力。",
  provider_failed: "外部 Agent 执行失败，请检查服务状态与配置。",
  storage_failed: "本地存储读写失败，请检查磁盘空间及写入权限。",
  shape_mismatch: "数据结构不匹配，请尝试重建会话索引。",
  internal: "系统发生内部错误，请重启应用后重试。",
};

export interface RpcErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
}

export function rpcError(code: ErrorCode, message: string): RpcErrorBody {
  return { code, message };
}
