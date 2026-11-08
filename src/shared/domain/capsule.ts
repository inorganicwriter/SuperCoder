/**
 * 上下文胶囊。遵循架构设计规范。
 *
 * 没有状态机：同一个 `capsuleId` 取最后一次 `capsule/saved`。
 */

import { z } from "zod";

export const CapsuleActionSchema = z.enum(["create", "update", "promote", "list"]);
export type CapsuleAction = z.infer<typeof CapsuleActionSchema>;

export const CapsuleScopeSchema = z.enum(["chat", "workspace"]);
export type CapsuleScope = z.infer<typeof CapsuleScopeSchema>;

export const CapsuleSchema = z.object({
  capsuleId: z.string(),
  title: z.string(),
  humanSummary: z.string(),
  technicalHandoff: z.string(),
  touchedFiles: z.array(z.string()),
  scope: CapsuleScopeSchema,
  /** 落到哪个会话（chat 作用域取会话，workspace 作用域取工作区）。 */
  sessionId: z.string(),
  workspaceId: z.string(),
  /** 第一次保存的时间；编辑不改它。共享上下文按它判断"是否在某个对话开始前就有"。 */
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Capsule = z.infer<typeof CapsuleSchema>;
