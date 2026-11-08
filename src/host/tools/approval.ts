/**
 * 工具执行权限审批流。
 *
 * 规则：
 * - 写操作默认每次问；用户可用 `remember: "turn" | "workspace"` 免问
 * - 免问范围只在本次运行内有效：重启后重新问（不会把"同意"永久写进磁盘）
 * - 被拒或超时都记 `denied`；`denied` 与 `error` 分开，因为那是人做的决定
 */

import { randomUUID } from "node:crypto";
import type { SessionHandle } from "../session/handle.js";
import type { Logger } from "../boot/logger.js";
import type { ApprovalPolicy } from "../boot/config.js";

export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

export type Decision = "allow" | "deny";
export type RememberScope = "none" | "turn" | "workspace";

export interface ApprovalOutcome {
  readonly decision: Decision;
  /** 拒绝原因，直接进 tool/result 的 message。 */
  readonly reason: string;
}

interface PendingApproval {
  readonly callId: string;
  readonly toolName: string;
  readonly session: SessionHandle;
  readonly resolve: (outcome: ApprovalOutcome) => void;
  readonly timer: NodeJS.Timeout;
}

export interface AskInput {
  readonly session: SessionHandle;
  readonly callId: string;
  readonly toolName: string;
  readonly signal: AbortSignal;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly remembered = {
    turn: new Set<string>(),
    workspace: new Set<string>(),
  };

  constructor(private readonly logger: Logger) {}

  /** 策略与免问记录共同决定要不要给人看。 */
  needsApproval(toolName: string, mutating: boolean, policy: ApprovalPolicy): boolean {
    if (policy === "never") return false;
    if (!mutating) return policy === "ask";
    if (this.remembered.workspace.has(toolName)) return false;
    if (this.remembered.turn.has(toolName)) return false;
    return true;
  }

  /** 挂起并等 `approval.respond`。超时或中断都按拒绝处理。 */
  ask(input: AskInput): Promise<ApprovalOutcome> {
    input.session.append("tool/approval-requested", { callId: input.callId });
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(input.callId);
        this.logger.warn({ callId: input.callId, tool: input.toolName }, "审批超时");
        resolve({
          decision: "deny",
          reason: `审批超时未处理，操作已中止。请重新发起调用并在审批卡片中允许。`,
        });
      }, APPROVAL_TIMEOUT_MS);
      timer.unref();

      const onAbort = (): void => {
        clearTimeout(timer);
        this.pending.delete(input.callId);
        resolve({ decision: "deny", reason: "回合已被中断，本次审批已取消。" });
      };
      input.signal.addEventListener("abort", onAbort, { once: true });

      this.pending.set(input.callId, {
        callId: input.callId,
        toolName: input.toolName,
        session: input.session,
        resolve: (outcome) => {
          input.signal.removeEventListener("abort", onAbort);
          resolve(outcome);
        },
        timer,
      });
    });
  }

  /** 来自 `approval.respond` 的决定。返回是否命中了一个待审批请求。 */
  respond(callId: string, decision: Decision, remember: RememberScope): boolean {
    const entry = this.pending.get(callId);
    if (entry === undefined) return false;
    clearTimeout(entry.timer);
    this.pending.delete(callId);
    entry.session.append("tool/decision", {
      callId,
      decision,
      remember,
      ...(decision === "deny" ? { reason: "用户拒绝" } : {}),
    });
    if (decision === "allow" && remember !== "none") {
      this.remembered[remember].add(entry.toolName);
      this.logger.info({ tool: entry.toolName, scope: remember }, "本运行内免问");
    }
    entry.resolve({
      decision,
      reason: decision === "deny" ? "用户拒绝了本次工具调用。" : "已允许",
    });
    return true;
  }

  /** `turn/end` 时清掉本轮免问。 */
  resetTurnScope(): void {
    this.remembered.turn.clear();
  }

  pendingCallIds(): string[] {
    return [...this.pending.keys()];
  }

  /** 诊断用：当前是否有东西在等人。 */
  get waiting(): number {
    return this.pending.size;
  }

  newCallId(): string {
    return randomUUID();
  }
}
