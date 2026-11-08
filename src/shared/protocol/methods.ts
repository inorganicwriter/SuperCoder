/**
 * RPC 方法表。含 Agent 原生模型配置扩展。
 *
 * 参数与返回值都在这里用 zod 定义：host 侧按它校验入参，client 侧按它校验回包。
 * 一个方法一行，数量与  逐行对上。
 */

import { z } from "zod";
import { CapsuleSchema } from "../domain/capsule.js";
import { McpServerInputSchema, McpServerSchema } from "../domain/mcp.js";
import { ModelProfileSchema, ModelProfileViewSchema, ModelTestResultSchema } from "../domain/model.js";
import { ProviderModelSchema, ProviderStatusSchema } from "../domain/provider.js";
import { TaskViewSchema } from "../domain/task.js";
import { WorkspaceSchema } from "../domain/workspace.js";
import { SessionSummarySchema } from "../session/derive.js";

const Empty = z.object({});

export const METHODS = {
  "system.info": {
    params: Empty,
    result: z.object({
      home: z.string(),
      platform: z.literal("win32"),
      /** 会话与索引的存放位置，诊断用。 */
      dbPath: z.string(),
    }),
  },

  "workspace.list": {
    params: Empty,
    result: z.object({ activeId: z.string(), items: z.array(WorkspaceSchema) }),
  },
  "workspace.add": {
    params: z.object({ path: z.string().min(1), name: z.string().optional() }),
    result: WorkspaceSchema,
  },
  "workspace.remove": {
    params: z.object({ id: z.string() }),
    result: Empty,
  },
  "workspace.activate": {
    params: z.object({ id: z.string() }),
    result: Empty,
  },

  "session.list": {
    params: z.object({ workspaceId: z.string() }),
    result: z.array(SessionSummarySchema),
  },
  "session.create": {
    params: z.object({ workspaceId: z.string(), title: z.string().optional() }),
    result: z.object({ sessionId: z.string() }),
  },
  "session.rename": {
    params: z.object({ sessionId: z.string(), title: z.string().min(1) }),
    result: Empty,
  },
  "session.delete": {
    params: z.object({ sessionId: z.string() }),
    result: Empty,
  },
  "session.rebuild": {
    params: z.object({ sessionId: z.string() }),
    result: Empty,
  },

  "message.send": {
    params: z.object({
      sessionId: z.string(),
      text: z.string(),
      attachments: z.array(z.string()).optional(),
    }),
    result: z.object({ turnId: z.string() }),
  },
  "turn.interrupt": {
    params: z.object({ sessionId: z.string(), turnId: z.string() }),
    result: Empty,
  },
  "message.rewind": {
    params: z.object({ sessionId: z.string(), toSeq: z.number().int().nonnegative() }),
    result: z.object({ restoredFiles: z.array(z.string()) }),
  },
  "approval.respond": {
    params: z.object({
      sessionId: z.string(),
      callId: z.string(),
      decision: z.enum(["allow", "deny"]),
      remember: z.enum(["none", "turn", "workspace"]),
    }),
    result: Empty,
  },
  "question.answer": {
    params: z.object({
      sessionId: z.string(),
      questionId: z.string(),
      answer: z.string(),
    }),
    result: Empty,
  },

  "task.list": {
    params: z.object({ sessionId: z.string() }),
    result: z.array(TaskViewSchema),
  },
  "task.get": {
    params: z.object({ sessionId: z.string(), taskId: z.string() }),
    result: TaskViewSchema,
  },
  "task.cancel": {
    params: z.object({ sessionId: z.string(), taskId: z.string() }),
    result: Empty,
  },
  "task.retry": {
    params: z.object({
      sessionId: z.string(),
      taskId: z.string(),
      /** 必须显式为 true；否则返回 denied。 */
      confirmSideEffects: z.boolean(),
    }),
    result: Empty,
  },

  "agent.list": {
    params: Empty,
    result: z.array(ProviderStatusSchema),
  },
  "agent.refresh": {
    params: Empty,
    result: z.array(ProviderStatusSchema),
  },
  "agent.model.set": {
    params: z.object({ agentId: z.string().min(1), model: z.string().max(256).nullable() }),
    result: Empty,
  },
  "agent.permission.set": {
    params: z.object({ agentId: z.string().min(1), policy: z.enum(["allow", "deny"]) }),
    result: Empty,
  },
  "agent.models": {
    params: z.object({ agentId: z.string().min(1), workspaceId: z.string().min(1) }),
    result: z.array(ProviderModelSchema),
  },

  "model.list": {
    params: Empty,
    result: z.array(ModelProfileViewSchema),
  },
  "model.upsert": {
    params: z.object({ profile: ModelProfileSchema }),
    result: Empty,
  },
  "model.remove": {
    params: z.object({ id: z.string() }),
    result: Empty,
  },
  "model.test": {
    params: z.object({ id: z.string() }),
    result: ModelTestResultSchema,
  },

  "capsule.list": {
    params: z.object({
      workspaceId: z.string(),
      sessionId: z.string().optional(),
    }),
    result: z.array(CapsuleSchema),
  },
  "capsule.update": {
    params: z.object({
      sessionId: z.string().min(1),
      capsuleId: z.string().min(1),
      title: z.string().trim().min(1).max(200),
      humanSummary: z.string().max(20_000),
      technicalHandoff: z.string().max(20_000),
      scope: z.enum(["chat", "workspace"]),
    }),
    result: Empty,
  },
  "capsule.remove": {
    params: z.object({ sessionId: z.string().min(1), capsuleId: z.string().min(1) }),
    result: Empty,
  },

  "mcp.list": {
    params: Empty,
    result: z.array(McpServerSchema),
  },
  "mcp.add": {
    params: z.object({ server: McpServerInputSchema }),
    result: Empty,
  },
  "mcp.remove": {
    params: z.object({ id: z.string() }),
    result: Empty,
  },
  "mcp.auth": {
    params: z.object({ id: z.string() }),
    result: z.object({ url: z.string() }),
  },

  "secret.set": {
    params: z.object({ key: z.string().min(1), value: z.string() }),
    result: Empty,
  },
  "secret.has": {
    params: z.object({ key: z.string().min(1) }),
    result: z.object({ has: z.boolean() }),
  },
  "secret.clear": {
    params: z.object({ key: z.string().min(1) }),
    result: Empty,
  },

  "diagnostics.export": {
    params: z.object({ sessionId: z.string().optional() }),
    result: z.object({ path: z.string() }),
  },
} as const;

export type MethodName = keyof typeof METHODS;

export const METHOD_NAMES = Object.keys(METHODS) as MethodName[];

export type MethodParams<M extends MethodName> = z.infer<(typeof METHODS)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.infer<(typeof METHODS)[M]["result"]>;

export function isMethodName(value: string): value is MethodName {
  return Object.prototype.hasOwnProperty.call(METHODS, value);
}
