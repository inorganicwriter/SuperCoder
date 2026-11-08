/**
 * 工具结果的构造器。遵循架构设计规范。
 *
 * 只有这三个出口：确定成功、确定失败、可能有副作用但结果未知。
 * 工具执行结果必须归纳为以下明确枚举状态之一。
 */

import type { ToolOutcome } from "../../shared/domain/tool.js";

export function toolOk(value: unknown): ToolOutcome {
  return { status: "ok", value };
}

export function toolError(
  code: "invalid_args" | "denied" | "timeout" | "failed" | "unknown_tool",
  message: string,
  retryable = true,
): ToolOutcome {
  return { status: "error", code, message, retryable };
}

export function toolUncertain(detail: string): ToolOutcome {
  return { status: "uncertain", code: "execution_state_unknown", detail };
}
