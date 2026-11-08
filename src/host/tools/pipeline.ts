/**
 * 工具调用流水线。遵循架构设计规范。
 *
 * 顺序固定：`tool/call` 落盘 → 参数校验 → 审批 → 执行 → 后处理 → `tool/result` 落盘。
 *
 * 两条硬规则：
 * - 先落 `tool/call` 再动手：崩溃后能看出"可能已经动了手"，于是记 `unknown`（C7）
 * - 执行中被打断或超时 → uncertain，记录为未知状态
 */

import { randomUUID } from "node:crypto";
import type { ApprovalPolicy } from "../boot/config.js";
import type { Logger } from "../boot/logger.js";
import { ToolOutcomeSchema, type ToolOutcome } from "../../shared/domain/tool.js";
import type { SessionHandle } from "../session/handle.js";
import type { ApprovalBroker } from "./approval.js";
import { toolError, toolOk, toolUncertain } from "./outcome.js";
import type { ToolContext, ToolRegistry } from "./registry.js";

export const TOOL_TIMEOUT_MS = 5 * 60 * 1000;
/** 结果上限：过大的工具结果不允许悄悄截断后当结果用（C6）。 */
export const TOOL_RESULT_MAX_CHARS = 1_000_000;

export interface PipelineDeps {
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly policy: () => ApprovalPolicy;
  readonly logger: Logger;
  readonly timeoutMs?: number;
}

export interface RunToolInput {
  readonly session: SessionHandle;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly mode: "read-only" | "write";
  readonly name: string;
  readonly args: unknown;
  readonly signal: AbortSignal;
}

export interface RunToolResult {
  readonly callId: string;
  readonly outcome: ToolOutcome;
}

export class ToolPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? TOOL_TIMEOUT_MS;
  }

  async run(input: RunToolInput): Promise<RunToolResult> {
    const callId = randomUUID();
    input.session.append("tool/call", { callId, name: input.name, args: input.args });

    const settle = (outcome: ToolOutcome): RunToolResult => {
      const checked = ToolOutcomeSchema.safeParse(outcome);
      const final: ToolOutcome = checked.success
        ? checked.data
        : {
            status: "error",
            code: "failed",
            message: "工具返回了不符合契约格式的结果。",
            retryable: false,
          };
      input.session.append("tool/result", { callId, outcome: final });
      return { callId, outcome: final };
    };

    const tool = this.deps.registry.get(input.name);
    if (tool === null) {
      return settle({
        status: "error",
        code: "unknown_tool",
        message: `没有这个工具：${input.name}。可用工具：${this.deps.registry.names().join(", ")}`,
        retryable: true,
      });
    }

    const parsed = this.deps.registry.parseArgs(input.name, input.args);
    if (!parsed.ok) {
      return settle({ status: "error", code: "invalid_args", message: parsed.message, retryable: true });
    }

    if (input.mode === "read-only" && tool.spec.mutating) {
      return settle({
        status: "error",
        code: "denied",
        message: `只读模式下不允许调用 ${input.name}。如需修改工作区，请在可写任务中执行。`,
        retryable: false,
      });
    }

    if (this.deps.approvals.needsApproval(input.name, tool.spec.mutating, this.deps.policy())) {
      const decision = await this.deps.approvals.ask({
        session: input.session,
        callId,
        toolName: input.name,
        signal: input.signal,
      });
      if (decision.decision === "deny") {
        return settle({ status: "error", code: "denied", message: decision.reason, retryable: true });
      }
    }

    if (input.signal.aborted) {
      return settle({
        status: "error",
        code: "denied",
        message: "回合在工具执行前已被中断，本次调用已取消。",
        retryable: true,
      });
    }

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    input.signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    timer.unref();

    const ctx: ToolContext = {
      session: input.session,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      mode: input.mode,
      signal: controller.signal,
    };

    let outcome: ToolOutcome;
    try {
      outcome = await tool.execute(parsed.value, ctx);
    } catch (error) {
      // 已经进了执行体：可能有副作用，只能记未知态。
      outcome = {
        status: "uncertain",
        code: "execution_state_unknown",
        detail: `工具执行发生异常：${error instanceof Error ? error.message : String(error)}。`,
      };
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", onAbort);
    }

    if (timedOut) {
      outcome = {
        status: "uncertain",
        code: "execution_state_unknown",
        detail: `工具执行超过 ${Math.round(this.timeoutMs / 1000)} 秒已中止。`,
      };
    } else if (controller.signal.aborted && outcome.status !== "ok") {
      outcome = {
        status: "uncertain",
        code: "execution_state_unknown",
        detail: `工具执行被中断，无法确认执行状态。`,
      };
    } else if (!controller.signal.aborted) {
      outcome = this.postProcess(outcome);
    }

    return settle(outcome);
  }

  /**
   * 后处理：形状校验 + 体积上限。
   *
   * 输出超限时不隐式截断，显式返回失败以避免上游消费残缺数据。
   */
  private postProcess(outcome: ToolOutcome): ToolOutcome {
    if (outcome.status !== "ok") return outcome;
    const size = safeJsonSize(outcome.value);
    if (size > TOOL_RESULT_MAX_CHARS) {
      return {
        status: "error",
        code: "failed",
        message: `工具结果过大（${size} 字符，上限 ${TOOL_RESULT_MAX_CHARS}），请缩小请求范围后重试。`,
        retryable: true,
      };
    }
    return outcome;
  }
}

function safeJsonSize(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : text.length;
  } catch {
    return TOOL_RESULT_MAX_CHARS + 1;
  }
}

export { toolError, toolOk, toolUncertain };
