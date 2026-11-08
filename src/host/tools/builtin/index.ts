/**
 * 八个内置工具的实现。遵循架构设计规范。
 *
 * 每个工具职责明确，变更记录于会话日志或工作区，统一由 pipeline 执行权限审批。
 * 这里不直接 spawn、不直接读盘：能力都从 `BuiltinToolServices` 注进来。
 */

import { randomUUID } from "node:crypto";
import { inRewindWindow } from "../../agent/context.js";
import { runProcess } from "../../boot/exec.js";
import { messageOf } from "../../boot/failure.js";
import {
  BUILTIN_TOOLS,
  DispatchTaskParams,
  resolveDispatchMode,
  type BuiltinToolName,
} from "../../../shared/domain/builtin-tools.js";
import type { Capsule } from "../../../shared/domain/capsule.js";
import type { DelegationEvent } from "../../../shared/domain/delegation.js";
import type { ProviderPage, ProviderSessionSummary, ProviderStatus } from "../../../shared/domain/provider.js";
import type { TaskType, TaskView } from "../../../shared/domain/task.js";
import type { SessionHandle } from "../../session/handle.js";
import { toolError, toolOk, toolUncertain } from "../outcome.js";
import type { ToolContext, ToolExecutor, ToolRegistry } from "../registry.js";

export interface DispatchToolInput {
  readonly session: SessionHandle;
  readonly workspaceId: string;
  readonly agentId: string;
  readonly goal: string;
  readonly instruction: string;
  readonly taskType: TaskType;
  readonly mode: "read-only" | "write";
  readonly resumeSessionId?: string;
  readonly parentTaskId?: string;
  readonly signal: AbortSignal;
}

export type DispatchPreflight =
  | { readonly status: "ok" }
  | { readonly status: "error"; readonly code: "invalid_args" | "denied"; readonly message: string };

/** 给模型看的形状用 snake_case：工具参数与结果都在模型侧流转。 */
export interface VerificationResult {
  readonly command: string;
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
}

export interface BuiltinToolServices {
  listAgents(): Promise<ProviderStatus[]>;
  /**
   * 任务派发前的模型有效性校验。返回错误时工具直接失败，不进执行体（见  的未知态语义）。
   */
  checkAgentModel?(agentId: string): DispatchPreflight;
  dispatch(input: DispatchToolInput): Promise<TaskView>;
  task(sessionId: string, taskId: string): TaskView | null;
  listProviderSessions(agentId: string, page: ProviderPage): Promise<ProviderSessionSummary[]>;
  readProviderSession(agentId: string, sessionId: string, page: ProviderPage): Promise<DelegationEvent[]>;
  capsules(workspaceId: string, sessionId: string): Capsule[];
  /** 默认验证命令（settings.verificationCommand）。 */
  verificationCommand(): string;
  /** 挂起等用户回答；中断返回 null。 */
  askUser(input: {
    readonly session: SessionHandle;
    readonly question: string;
    readonly options: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<string | null>;
}

const MAX_VERIFICATION_OUTPUT = 60_000;

/**
 * 把工具装进注册表。`registry.register` 用的是共享契约里的 spec，
 * 所以工具数量与  的行数天然一致（少一个就少注册一个）。
 */
export function registerBuiltinTools(registry: ToolRegistry, services: BuiltinToolServices): void {
  const handlers: Record<BuiltinToolName, ToolExecutor> = {
    list_available_agents: async () => {
      const agents = await services.listAgents();
      return toolOk({
        // 只给模型做决定需要的：能不能任务分派、用哪个模型、不能用时的原因。
        // 内部能力表（接入级别、只读沙箱、是否官方 SDK）一律不透传：模型会把它们
        // 复述成"只读""兼容模式"之类的标注，而权限本来就由宿主按 allow_write 执行。
        agents: agents.map((agent) => {
          const available = agent.installed && agent.level !== null && agent.level !== 4;
          return {
            id: agent.id,
            label: agent.label,
            available,
            ...(agent.selectedModel === undefined ? {} : { model: agent.selectedModel }),
            ...(agent.reason === undefined || available ? {} : { reason: agent.reason }),
          };
        }),
      });
    },

    dispatch_task: async (raw, ctx) => {
      const args = DispatchTaskParams.parse(raw);
      if (ctx.workspacePath === "") {
        return toolError(
          "denied",
          "当前会话关联的工作区目录已不存在，无法分派任务。",
          false,
        );
      }
      const mode = resolveDispatchMode(args.task_type, args.allow_write);
      // 模型配置在任务分派前校验：档案被删是配置问题，不是"执行状态未知"。
      const model = services.checkAgentModel?.(args.agent_id);
      if (model !== undefined && model.status === "error") {
        return toolError(model.code, model.message, false);
      }
      if (args.session_id !== undefined && args.session_id !== "") {
        // 通过历史或协议返回的会话存在标记验证，再由执行者校验可恢复性。
        try {
          const events = await services.readProviderSession(args.agent_id, args.session_id, { offset: 0, limit: 1 });
          if (events.length === 0) throw new Error("会话不存在或没有可验证的历史");
        } catch (error) {
          return toolError(
            "denied",
            `外部会话 ${args.session_id} 无法恢复：${messageOf(error)}。请尝试开启新会话重派。`,
            false,
          );
        }
      }
      const rewind = ctx.session.view().rewind;
      const window = rewind === null ? null : { toSeq: rewind.toSeq, seq: rewind.seq };
      const latestUser = [...ctx.session.allEvents()].reverse().find((event) => event.type === "user/message" && inRewindWindow(event.seq, window));
      const original = latestUser?.type === "user/message" && latestUser.text !== "" ? latestUser.text : args.instruction;
      // 默认续话：同一个 SuperCoder 对话里，同一个 Agent 最近一次成功的原生会话接着用。
      // 只有显式 session_id（指定会话）或 new_session（明确要新开）时才不走这条。
      const continued =
        args.session_id === undefined && args.new_session !== true
          ? latestNativeSession(ctx.session.view().tasks, args.agent_id)
          : undefined;
      const resumeSessionId = args.session_id ?? continued;
      const upstream: Array<{ task_id: string; agent_id: string; answer: string }> = [];
      for (const id of args.context_task_ids ?? []) {
        const prior = services.task(ctx.session.sessionId, id);
        if (!prior || prior.result?.status !== "ok") return toolError("invalid_args", `前序任务 ${id} 不存在或没有成功结果，无法作为已完成的上下文传递。`, false);
        // 在同一个原生会话里完成的任务，Agent 自己的历史里已经有结果，不再重复附带。
        if (resumeSessionId !== undefined && prior.nativeSessionId === resumeSessionId) continue;
        upstream.push({ task_id: id, agent_id: prior.agentId, answer: prior.result.answer });
      }
      const necessary = upstream.filter((item) => !args.instruction.includes(item.answer));
      const handoff = necessary.length === 0 ? args.instruction : `${args.instruction}\n\n${necessary.map((item) => `Previous result (${item.agent_id}):\n${item.answer}`).join("\n\n")}`;
      const run = (resume: string | undefined) =>
        services.dispatch({
          session: ctx.session,
          workspaceId: ctx.workspaceId,
          agentId: args.agent_id,
          goal: original,
          instruction: original === handoff ? "" : handoff,
          taskType: args.task_type,
          mode,
          ...(resume === undefined ? {} : { resumeSessionId: resume }),
          ...(args.parent_task_id === undefined ? {} : { parentTaskId: args.parent_task_id }),
          signal: ctx.signal,
        });
      let task = await run(resumeSessionId);
      // 自动续话在交付前就失败（例如对方会话已过期）时，开新会话重试一次；已提交过的不重试。
      if (
        continued !== undefined &&
        task.result?.status === "failed" &&
        ["detect", "spawn", "handshake"].includes(task.result.diagnostic.stage) &&
        !ctx.signal.aborted
      ) {
        task = await run(undefined);
      }
      return toolOk({
        task_id: task.taskId,
        state: task.state,
        provider: task.providerId,
        mode: task.mode,
        ...(task.nativeSessionId === undefined ? {} : { session_id: task.nativeSessionId }),
        ...(continued !== undefined && task.nativeSessionId === continued ? { continued_session: true } : {}),
        result: task.result,
      });
    },

    query_task_status: async (raw, ctx) => {
      const args = raw as { task_id: string };
      const task = services.task(ctx.session.sessionId, args.task_id);
      if (task === null) {
        return toolError("invalid_args", `未找到指定任务：${args.task_id}。`, false);
      }
      // 纯读：零模型调用、零 Git 扫描。
      return toolOk(task);
    },

    list_agent_sessions: async (raw) => {
      const args = raw as { agent_id: string; offset: number; limit: number };
      const sessions = await services.listProviderSessions(args.agent_id, {
        offset: args.offset,
        limit: args.limit,
      });
      return toolOk({ sessions });
    },

    read_agent_session: async (raw) => {
      const args = raw as { agent_id: string; session_id: string; offset: number; limit: number };
      const events = await services.readProviderSession(args.agent_id, args.session_id, {
        offset: args.offset,
        limit: args.limit,
      });
      return toolOk({ events });
    },

    manage_context_capsule: async (raw, ctx) => {
      const args = raw as {
        action: "create" | "update" | "promote" | "list";
        capsule_id?: string;
        title?: string;
        human_summary?: string;
        technical_handoff?: string;
        touched_files?: string[];
        scope: "chat" | "workspace";
      };
      if (args.action === "list") {
        return toolOk({ capsules: services.capsules(ctx.workspaceId, ctx.session.sessionId) });
      }
      if (args.action === "update" || args.action === "promote") {
        if (args.capsule_id === undefined) {
          return toolError("invalid_args", `${args.action} 操作需要提供 capsule_id。`, true);
        }
      }
      const capsuleId = args.capsule_id ?? `cap_${randomUUID()}`;
      const action = args.action === "promote" ? "promote" : args.action === "update" ? "update" : "create";
      ctx.session.append("capsule/saved", {
        capsuleId,
        action,
        title: args.title ?? "未命名胶囊",
        humanSummary: args.human_summary ?? "",
        technicalHandoff: args.technical_handoff ?? "",
        touchedFiles: args.touched_files ?? [],
        scope: args.action === "promote" ? "workspace" : args.scope,
      });
      return toolOk({ capsule_id: capsuleId, action });
    },

    run_workspace_verification: async (raw, ctx) => {
      if (ctx.workspacePath === "") {
        return toolError(
          "denied",
          "当前会话关联的工作区不存在，无法执行验证命令。",
          false,
        );
      }
      const args = raw as { custom_cmd?: string };
      const command = args.custom_cmd ?? services.verificationCommand();
      const parts = splitCommand(command);
      if (!parts.ok) {
        return toolError("invalid_args", parts.message, true);
      }
      const [bin, ...rest] = parts.value;
      if (bin === undefined) {
        return toolError("invalid_args", "验证命令为空，请在设置中配置验证命令。", true);
      }
      const result = await runProcess(bin, rest, {
        cwd: ctx.workspacePath,
        timeoutMs: 120_000,
        signal: ctx.signal,
      });
      if (result.timedOut) {
        return toolUncertain(`验证命令执行超时（120 秒）：${command}，请确认其执行状态。`);
      }
      if (result.overflowed) {
        // 进程异常终止且输出被截断，返回失败状态而非不完整输出。
        return toolError(
          "failed",
          `验证命令输出超过上限已中止：${command}。请调整命令以限制输出量。`,
          true,
        );
      }
      const stdout = result.stdout;
      const stderr = result.stderr;
      if (stdout.length + stderr.length > MAX_VERIFICATION_OUTPUT) {
        return toolError(
          "failed",
          `验证输出超出大小限制（${stdout.length + stderr.length} / ${MAX_VERIFICATION_OUTPUT} 字符）。`,
          true,
        );
      }
      if (result.code === null) {
        return toolError(
          "failed",
          `无法启动验证命令：${command}（${stderr.trim() || "可执行文件不存在"}）。`,
          true,
        );
      }
      return toolOk({
        command,
        exit_code: result.code,
        stdout,
        stderr,
        duration_ms: result.durationMs,
      } satisfies VerificationResult);
    },

    ask_user_decision: async (raw, ctx) => {
      const args = raw as { question: string; options?: string[] };
      const answer = await services.askUser({
        session: ctx.session,
        question: args.question,
        options: args.options ?? [],
        signal: ctx.signal,
      });
      if (answer === null) {
        return toolError("denied", "用户尚未回答，回合已中断。", true);
      }
      return toolOk({ answer });
    },
  };

  for (const spec of Object.values(BUILTIN_TOOLS)) {
    const handler = handlers[spec.name];
    registry.register(spec, handler);
  }
}

/** 命令拆分：只支持空格分隔与成对引号，不解释 shell 通配/管道。 */
export function splitCommand(
  command: string,
): { ok: true; value: string[] } | { ok: false; message: string } {
  const trimmed = command.trim();
  if (trimmed === "") return { ok: false, message: "命令为空" };
  if (/[|&;<>`$]/.test(trimmed)) {
    return {
      ok: false,
      message: `命令包含 shell 元字符（| & ; < > \` $），请指定单一可执行文件及其参数。`,
    };
  }
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of trimmed) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === " " || char === "\t") {
      if (current !== "") {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote !== null) return { ok: false, message: "命令里的引号没有闭合" };
  if (current !== "") parts.push(current);
  if (parts.length === 0) return { ok: false, message: "命令为空" };
  return { ok: true, value: parts };
}

export type { ToolContext };

/**
 * 同一个 SuperCoder 对话里，这个 Agent 最近一次成功的原生会话。
 * 按任务分派顺序（spawn 序号）取最后一个；失败或没有原生会话 ID 的任务不算。
 */
export function latestNativeSession(tasks: readonly TaskView[], agentId: string): string | undefined {
  let best: TaskView | undefined;
  for (const task of tasks) {
    if (task.agentId !== agentId || task.nativeSessionId === undefined || task.result?.status !== "ok") continue;
    if (best === undefined || (task.seq ?? 0) >= (best.seq ?? 0)) best = task;
  }
  return best?.nativeSessionId;
}
