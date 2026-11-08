/**
 * 内置工具契约。遵循架构设计规范（8 个，名称与参数固定）。
 *
 * 参数 schema 同时用于三处：模型侧 JSON Schema（tools/gen-schema.ts）、
 * 执行前的参数校验、单测。
 */

import { z } from "zod";

export const BUILTIN_TOOL_NAMES = [
  "list_available_agents",
  "dispatch_task",
  "query_task_status",
  "list_agent_sessions",
  "read_agent_session",
  "manage_context_capsule",
  "run_workspace_verification",
  "ask_user_decision",
] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[number];

export const ListAvailableAgentsParams = z.object({});

export const DispatchTaskParams = z.object({
  agent_id: z.string().describe("ID of the selected available agent; honor the user's choice."),
  instruction: z.string().min(1).describe("A concise, direct task for this agent. Include only the context and user-specified constraints needed to act; the user's original message is not appended automatically."),
  task_type: z.enum(["general", "plan", "implement", "review", "fix"]).describe("The work assigned in this stage; review or plan does not by itself require a read-only sandbox."),
  allow_write: z.boolean().describe("Whether the selected agent may write, based on user instructions and agent capabilities. Do not set false automatically for analysis; false requests enforced read-only mode."),
  session_id: z.string().optional().describe("Resume this specific native session of the agent. Usually omit it: by default the host continues the agent's latest successful session in this chat."),
  new_session: z.boolean().optional().describe("Start a fresh agent session instead of continuing the previous one. Set true only when the user asks for a new session or the work is unrelated."),
  parent_task_id: z.string().optional().describe("Related parent task ID, if this is a follow-up stage."),
  context_task_ids: z.array(z.string().min(1)).max(8).optional().describe("IDs of successful earlier tasks whose complete answers this agent needs. The host appends them; do not repeat them in instruction or use failed tasks."),
});
export type DispatchTaskParams = z.infer<typeof DispatchTaskParams>;

export const QueryTaskStatusParams = z.object({ task_id: z.string() });

export const ListAgentSessionsParams = z.object({
  agent_id: z.string(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
});

export const ReadAgentSessionParams = z.object({
  agent_id: z.string(),
  session_id: z.string(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
});

export const ManageContextCapsuleParams = z.object({
  action: z.enum(["create", "update", "promote", "list"]),
  capsule_id: z.string().optional(),
  title: z.string().optional(),
  human_summary: z.string().optional(),
  technical_handoff: z.string().optional(),
  touched_files: z.array(z.string()).optional(),
  scope: z.enum(["chat", "workspace"]),
});

export const RunWorkspaceVerificationParams = z.object({
  custom_cmd: z.string().optional().describe("One executable with arguments, e.g. \"pnpm test\". Runs without a shell: no pipes, &&, ;, redirects or $variables. Omit to use the configured command."),
});

export const AskUserDecisionParams = z.object({
  question: z.string().min(1),
  options: z.array(z.string()).optional(),
});

export interface BuiltinToolSpec {
  readonly name: BuiltinToolName;
  /** 模型看到的描述。产品文案，走 locale 之外的固定英文，模型侧统一。 */
  readonly description: string;
  readonly params: z.ZodTypeAny;
  /** 会写盘 / 写工作区，需要审批。 */
  readonly mutating: boolean;
}

export const BUILTIN_TOOLS: Readonly<Record<BuiltinToolName, BuiltinToolSpec>> = {
  list_available_agents: {
    name: "list_available_agents",
    description:
      "List the enabled executors (external coding agents) with their capabilities and installation state.",
    params: ListAvailableAgentsParams,
    mutating: false,
  },
  dispatch_task: {
    name: "dispatch_task",
    description:
      "Run a direct task with the selected agent. Use context_task_ids when the next stage needs a successful prior result; wait for required results before starting dependent stages.",
    params: DispatchTaskParams,
    mutating: true,
  },
  query_task_status: {
    name: "query_task_status",
    description: "Read the current state of a delegated task. Pure in-memory read, zero side effects.",
    params: QueryTaskStatusParams,
    mutating: false,
  },
  list_agent_sessions: {
    name: "list_agent_sessions",
    description: "List the executor's own historical sessions for the current workspace.",
    params: ListAgentSessionsParams,
    mutating: false,
  },
  read_agent_session: {
    name: "read_agent_session",
    description: "Read one page of an executor's own historical session transcript.",
    params: ReadAgentSessionParams,
    mutating: false,
  },
  manage_context_capsule: {
    name: "manage_context_capsule",
    description:
      "Create, update, promote or list a context capsule (handoff summary with touched files).",
    params: ManageContextCapsuleParams,
    mutating: true,
  },
  run_workspace_verification: {
    name: "run_workspace_verification",
    description: "Run the workspace verification command (or one custom command without shell operators) and return its output.",
    params: RunWorkspaceVerificationParams,
    mutating: true,
  },
  ask_user_decision: {
    name: "ask_user_decision",
    description:
      "Ask the user to choose. The turn stays suspended until the user answers or interrupts.",
    params: AskUserDecisionParams,
    mutating: false,
  },
};

export const BUILTIN_TOOL_LIST: readonly BuiltinToolSpec[] = BUILTIN_TOOL_NAMES.map(
  (name) => BUILTIN_TOOLS[name],
);

export function isBuiltinToolName(value: string): value is BuiltinToolName {
  return (BUILTIN_TOOL_NAMES as readonly string[]).includes(value);
}

/** Respect the explicitly requested permission for every task type. */
export function resolveDispatchMode(
  _taskType: z.infer<typeof DispatchTaskParams>["task_type"],
  allowWrite: boolean,
): "read-only" | "write" {
  return allowWrite ? "write" : "read-only";
}
