/**
 * 任务分派执行器。遵循架构设计规范。
 *
 * 一次任务分派的落盘顺序是固定的：
 * `delegation/spawn` → `delegation/delivery`×N → `delegation/result`
 * 任务视图全部由这三类事件派生，所以重启后任务状态不会丢。
 *
 * 三条硬规则：
 * - 写任务先拿工作区写锁，拿不到直接拒（C4）
 * - 中断在"已提交"之后 → `aborted`；进程消失无法确认 → `unknown`（不重试）
 * - `unknown` 之后的重试必须由用户显式确认副作用
 */

import { randomUUID } from "node:crypto";
import type {
  DelegationEvent,
  DelegationResult,
  SafeDiagnostic,
  AgentModelConfig,
} from "../../shared/domain/delegation.js";
import type { TaskMode, TaskType, TaskView } from "../../shared/domain/task.js";
import type { Logger } from "../boot/logger.js";
import { fail, isRpcFailure, messageOf } from "../boot/failure.js";
import type { SessionHandle } from "../session/handle.js";
import { snapshotWorkspace } from "../workspace/snapshot.js";
import type { WorkspaceLocks } from "../workspace/locks.js";
import type { ProviderSelect } from "./provider-select.js";

/** 流式输出落盘的聚合窗口（毫秒）。 */
const OUTPUT_FLUSH_MS = 80;

export interface DelegationRunnerDeps {
  readonly select: ProviderSelect;
  readonly locks: WorkspaceLocks;
  readonly logger: Logger;
}

export interface DispatchInput {
  readonly session: SessionHandle;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly agentId: string;
  readonly goal: string;
  readonly instruction: string;
  readonly mode: TaskMode;
  readonly taskType: TaskType;
  readonly model?: string;
  readonly modelConfig?: AgentModelConfig;
  readonly resumeSessionId?: string;
  readonly parentTaskId?: string;
  readonly signal: AbortSignal;
}

export interface RetryInput {
  readonly session: SessionHandle;
  readonly workspacePath: string;
  readonly taskId: string;
  /** 前序执行状态为未知时，需调用方确认已评估副作用后再发起重试。 */
  readonly confirmSideEffects: boolean;
  readonly modelConfig?: AgentModelConfig;
  readonly signal: AbortSignal;
}

export class DelegationRunner {
  private readonly inflight = new Map<string, AbortController>();

  constructor(private readonly deps: DelegationRunnerDeps) {}

  /** 任务分派：返回从日志派生出来的任务视图（不自己维护第二份状态）。 */
  async dispatch(input: DispatchInput): Promise<TaskView> {
    return this.execute(input, `task_${randomUUID()}`);
  }

  /**
   * 重试前的同步校验：任务存在、`unknown` 已确认副作用、同任务没在跑。
   *
   * 单独抽出来是因为 RPC 不能同步等整次任务分派（可能跑几分钟，会撞 120 秒超时），
   * 但"要不要接受这次重试"是同步就能判断的，必须让调用方看见拒绝原因。
   * 返回这个任务的视图，`retry()` 直接沿用，避免两处各查一遍。
   */
  assertRetryAllowed(
    session: SessionHandle,
    taskId: string,
    confirmSideEffects: boolean,
  ): TaskView {
    const task = session.view().tasks.find((candidate) => candidate.taskId === taskId);
    if (task === undefined) {
      fail("not_found", `未找到指定任务：${taskId}。`);
    }
    if (task.state === "unknown" && !confirmSideEffects) {
      fail(
        "denied",
        "前序任务状态未知（可能已修改工作区），请确认副作用后重试。",
      );
    }
    const sameTask = this.inflight.get(taskId);
    if (sameTask !== undefined) {
      fail("busy", `任务仍在执行中，请等待其执行完成或手动中断。`);
    }
    return task;
  }

  /**
   * 重试同一任务：沿用 childId，因此 `retryCount`（派生自 spawn 次数）自增。
   * `unknown` 态必须先确认副作用。
   */
  async retry(input: RetryInput): Promise<TaskView> {
    const task = this.assertRetryAllowed(input.session, input.taskId, input.confirmSideEffects);
    return this.execute(
      {
        session: input.session,
        workspaceId: input.session.meta.workspace,
        workspacePath: input.workspacePath,
        agentId: task.agentId,
        goal: task.goal,
        instruction: task.instruction,
        mode: task.mode,
        ...(task.selectedModel === undefined ? {} : { model: task.selectedModel }),
        ...(input.modelConfig === undefined ? {} : { modelConfig: input.modelConfig }),
        taskType: task.taskType ?? "general",
        signal: input.signal,
      },
      input.taskId,
    );
  }

  /** `task.interrupt`：中断正在跑的任务分派。没有在跑就返回 false。 */
  interrupt(sessionId: string, taskId: string): boolean {
    const controller = this.inflight.get(taskId);
    if (controller === undefined) return false;
    controller.abort();
    this.deps.logger.info({ taskId, sessionId }, "中断任务分派");
    return true;
  }

  inflightIds(): string[] {
    return [...this.inflight.keys()];
  }

  private async execute(input: DispatchInput, childId: string): Promise<TaskView> {
    const { select, locks, logger } = this.deps;
    const candidates = await select.resolveCandidates(input.agentId);
    let resolved = candidates[0]!;

    if (input.mode === "write") {
      const acquired = locks.acquire(input.workspaceId, childId);
      if (!acquired.ok) fail("busy", acquired.error);
      try {
        this.takeSnapshot(input, childId);
      } catch (error) {
        locks.release(input.workspaceId, childId);
        // 快照自己给过下一步（例如超过文件数上限）就原样抛，别拼第二个"下一步"。
        if (isRpcFailure(error)) throw error;
        fail("storage_failed", `创建工作区快照失败：${messageOf(error)}。`);
      }
    }

    // 这条 append 已经在写锁之内：写盘失败要先把锁放掉再抛，否则这个工作区
    // 在本次运行里再也派不出写入型任务（锁只在内存里，重启才恢复）。
    try {
      input.session.append("delegation/spawn", {
        childId,
        provider: resolved.provider.id,
        agentId: input.agentId,
        instruction: input.instruction,
        goal: input.goal,
        mode: input.mode,
        ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
      });
      input.session.append("delegation/progress", { childId, event: { type: "trace", summary: `task-type:${input.taskType}` } });
      if (input.model !== undefined) input.session.append("delegation/progress", { childId, event: { type: "trace", summary: `model:${input.model}` } });
      if (input.modelConfig !== undefined) input.session.append("delegation/progress", { childId, event: { type: "trace", summary: `model-name:${input.modelConfig.model}` } });
    } catch (error) {
      if (input.mode === "write") locks.release(input.workspaceId, childId);
      // 日志写失败本身就是带下一步的 RpcFailure，原样抛；别的错误补上下文。
      if (isRpcFailure(error)) throw error;
      fail(
        "storage_failed",
        `任务分派写入日志失败（${messageOf(error)}），请检查数据目录。`,
      );
    }

    const controller = new AbortController();
    const onOuterAbort = (): void => controller.abort();
    input.signal.addEventListener("abort", onOuterAbort, { once: true });
    if (input.signal.aborted) controller.abort();
    this.inflight.set(childId, controller);

    // 流式输出按时间窗口聚合成一条 `delegation/progress`：逐 token 落盘会让日志膨胀到
    // 几千行一条答案，派生时还要逐条拼字符串（O(n²)）。80ms 对界面来说已经是连续的了。
    let pendingOutput = "";
    let flushTimer: NodeJS.Timeout | null = null;
    const flushOutput = (): void => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (pendingOutput === "") return;
      const text = pendingOutput;
      pendingOutput = "";
      input.session.append("delegation/progress", { childId, event: { type: "output", text } });
    };
    const record = (event: DelegationEvent): void => {
      if (event.type === "output") {
        pendingOutput += event.text;
        if (flushTimer === null) flushTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS);
        return;
      }
      // 其它事件要先落地，顺序不能乱。
      flushOutput();
      this.recordEvent(input.session, childId, event);
    };

    let result: DelegationResult;
    let wasSubmitted = false;
    try {
      let attempt = 0;
      while (true) {
        let submitted = false;
        result = await resolved.provider.delegate({
          childId,
          agentId: input.agentId,
          workspace: input.workspacePath,
          goal: input.goal,
          instruction: input.instruction,
          mode: input.mode,
          taskType: input.taskType,
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.modelConfig === undefined ? {} : { modelConfig: input.modelConfig }),
          ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === "trace" && event.summary === "delivery:submitted") { submitted = true; wasSubmitted = true; }
            record(event);
          },
        });
        const safeFailure = result.status === "failed" && ["detect", "spawn", "handshake"].includes(result.diagnostic.stage);
        if (safeFailure && submitted) result = { status: "unknown", observed: "执行者已提交任务但报告启动阶段失败，无法确认副作用", since: new Date().toISOString() };
        const next = candidates[attempt + 1];
        if (!safeFailure || submitted || controller.signal.aborted || next === undefined || input.resumeSessionId) break;
        attempt += 1;
        resolved = next;
        input.session.append("delegation/progress", { childId, event: { type: "trace", summary: `provider:${resolved.provider.id}` } });
      }
    } catch (error) {
      result = wasSubmitted
        ? { status: "unknown", observed: messageOf(error).slice(0, 200), since: new Date().toISOString() }
        : classifyThrow(error, controller.signal);
    } finally {
      input.signal.removeEventListener("abort", onOuterAbort);
      this.inflight.delete(childId);
      if (input.mode === "write") locks.release(input.workspaceId, childId);
      // 收尾时把剩下的输出写完，再让 `delegation/result` 落盘。
      flushOutput();
    }

    input.session.append("delegation/result", { childId, result });
    logger.info(
      { childId, agentId: input.agentId, status: result.status, level: resolved.level },
      "任务分派结束",
    );

    const view = input.session
      .view()
      .tasks.find((candidate) => candidate.taskId === childId);
    if (view === undefined) {
      fail("storage_failed", "任务分派结果未能在任务视图中正常派生。");
    }
    return view;
  }

  private recordEvent(session: SessionHandle, childId: string, event: DelegationEvent): void {
    if (event.type === "trace" && event.summary.startsWith("delivery:")) {
      const state = event.summary.slice("delivery:".length);
      if (state === "queued" || state === "submitted" || state === "received" || state === "returned") {
        session.append("delegation/delivery", { childId, state });
      }
    } else if (event.type === "output" || event.type === "session") {
      session.append("delegation/progress", { childId, event });
    }
  }

  private takeSnapshot(input: DispatchInput, childId: string): void {
    const snapshot = snapshotWorkspace(input.workspacePath);
    input.session.append("snapshot/taken", {
      taskId: childId,
      files: snapshot.files.map((file) => ({
        path: file.path,
        mtimeMs: file.mtimeMs,
        size: file.size,
      })),
    });
  }
}

/** 捕获未处理异常并映射为四种标准任务结果之一。 */
function classifyThrow(error: unknown, signal: AbortSignal): DelegationResult {
  if (signal.aborted) return { status: "aborted", durationMs: 0 };
  const message = messageOf(error);
  const diagnostic: SafeDiagnostic = {
    stage: "turn",
    category: "unknown",
    detail: message.slice(0, 200),
  };
  return { status: "failed", diagnostic, durationMs: 0 };
}
