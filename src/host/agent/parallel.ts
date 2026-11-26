/**
 * 单回合工具调用的并行分组规划器。
 *
 * 将独立、无冲突的工具调用（只读查询、只读委派、或已开启 Worktree 隔离的可写委派）
 * 划入同一并行批次；存在副作用串行约束或原生会话续话冲突的调用按原顺序单独成批。
 */

import { DispatchTaskParams, resolveDispatchMode } from "../../shared/domain/builtin-tools.js";
import type { ToolCallRequest } from "../models/llm.js";

export const MAX_PARALLEL_CALLS = 4;

export type PreparedToolCall =
  | { readonly kind: "invalid"; readonly call: ToolCallRequest; readonly message: string }
  | { readonly kind: "valid"; readonly call: ToolCallRequest; readonly args: unknown };

export interface ParallelPolicy {
  readonly canParallelDispatch?: ((agentId: string, mode: "read-only" | "write") => boolean) | undefined;
  readonly maxParallel?: number | undefined;
}

interface CallClassification {
  readonly safe: boolean;
  readonly key: string | null;
}

const READ_ONLY_BUILTIN_TOOLS = new Set([
  "list_available_agents",
  "query_task_status",
  "list_agent_sessions",
  "read_agent_session",
]);

function classifyCall(item: PreparedToolCall, policy: ParallelPolicy): CallClassification {
  if (item.kind === "invalid") {
    return { safe: false, key: null };
  }
  const { name } = item.call;
  if (READ_ONLY_BUILTIN_TOOLS.has(name)) {
    return { safe: true, key: null };
  }
  if (name === "manage_context_capsule") {
    const isList =
      typeof item.args === "object" &&
      item.args !== null &&
      !Array.isArray(item.args) &&
      (item.args as Record<string, unknown>)["action"] === "list";
    return { safe: isList, key: null };
  }
  if (name === "dispatch_task") {
    const parsed = DispatchTaskParams.safeParse(item.args);
    if (!parsed.success) {
      return { safe: false, key: null };
    }
    const mode = resolveDispatchMode(parsed.data.task_type, parsed.data.allow_write);
    const allowed =
      mode === "read-only" ||
      (mode === "write" && policy.canParallelDispatch?.(parsed.data.agent_id, "write") === true);
    if (!allowed) {
      return { safe: false, key: null };
    }
    // 防止同一步并发委派命中同一个原生会话导致会话文件争抢。
    let sessionKey: string | null;
    if (parsed.data.session_id !== undefined && parsed.data.session_id !== "") {
      sessionKey = `session:${parsed.data.agent_id}:${parsed.data.session_id}`;
    } else if (parsed.data.new_session === true) {
      sessionKey = null;
    } else {
      sessionKey = `agent:${parsed.data.agent_id}`;
    }
    return { safe: true, key: sessionKey };
  }
  return { safe: false, key: null };
}

export function partitionToolCalls(
  calls: readonly PreparedToolCall[],
  policy: ParallelPolicy = {},
): PreparedToolCall[][] {
  const maxParallel = Math.max(1, policy.maxParallel ?? MAX_PARALLEL_CALLS);
  const batches: PreparedToolCall[][] = [];
  let current: PreparedToolCall[] = [];
  const usedKeys = new Set<string>();

  const flush = (): void => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      usedKeys.clear();
    }
  };

  for (const item of calls) {
    const verdict = classifyCall(item, policy);
    if (!verdict.safe) {
      flush();
      batches.push([item]);
      continue;
    }
    if (current.length >= maxParallel || (verdict.key !== null && usedKeys.has(verdict.key))) {
      flush();
    }
    current.push(item);
    if (verdict.key !== null) usedKeys.add(verdict.key);
  }

  flush();
  return batches;
}
