/**
 * Provider 契约。遵循架构设计规范。
 *
 * 这里是两端共用的形状定义：host 侧实现，client 侧只读展示。
 * 判据只有一句：fragility 不是 official 时，界面必须显示"兼容模式"角标。
 */

import { z } from "zod";
import type { DelegationEvent, DelegationRequest, DelegationResult } from "./delegation.js";

/** 兼容性声明。官方协议 / 有文档的 CLI / 逆向出来的私有存储。 */
export const FragilitySchema = z.enum(["official", "documented", "reverse-engineered"]);
export type Fragility = z.infer<typeof FragilitySchema>;

/** 回执四态。 */
export const ReceiptStateSchema = z.enum(["queued", "submitted", "received", "returned"]);
export type ReceiptState = z.infer<typeof ReceiptStateSchema>;

export const ProviderCapabilitiesSchema = z.object({
  readOnly: z.boolean(),
  resume: z.boolean(),
  effort: z.boolean(),
  streaming: z.boolean(),
  receiptStates: z.array(ReceiptStateSchema),
  fragility: FragilitySchema,
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderInstallationSchema = z.object({
  installed: z.boolean(),
  version: z.string().optional(),
  binaryPath: z.string().optional(),
  reason: z.string().optional(),
});
export type ProviderInstallation = z.infer<typeof ProviderInstallationSchema>;

/** Provider 级联匹配。写入型任务只用 1–3 级，第 4 级只承担读取历史会话。 */
export const ProviderLevelSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type ProviderLevel = z.infer<typeof ProviderLevelSchema>;

/** `agent.list` / `agent.refresh` 的返回项。 */
export const ProviderStatusSchema = z.object({
  id: z.string(),
  label: z.string(),
  installed: z.boolean(),
  /** 探测成功的级别；未安装时为 null。 */
  level: ProviderLevelSchema.nullable(),
  fragility: FragilitySchema.nullable(),
  /** 兼容模式角标（locale key `delegation.compatBadge`）。 */
  compat: z.boolean(),
  version: z.string().optional(),
  binaryPath: z.string().optional(),
  reason: z.string().optional(),
  capabilities: ProviderCapabilitiesSchema,
  checkedAt: z.string(),
  selectedModel: z.string().optional(),
  permissionPolicy: z.enum(["allow", "deny"]).optional(),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const ProviderSessionSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  updatedAt: z.string(),
});
export type ProviderSessionSummary = z.infer<typeof ProviderSessionSummarySchema>;

export const ProviderModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  current: z.boolean().optional(),
  /** 模型所属的供应商（界面按它分组）；Agent 没报告时缺省。 */
  provider: z.string().optional(),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

export const ProviderPageSchema = z.object({
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(100),
});
export type ProviderPage = z.infer<typeof ProviderPageSchema>;

export interface DelegationHandle {
  readonly childId: string;
  readonly providerId: string;
  readonly abort: () => void;
}

/** 每个 provider 对这四个能力各自实现：探测、列历史、读历史、任务分派。 */
export interface DelegationProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  detect(): Promise<ProviderInstallation>;
  listModels?(workspace: string): Promise<ProviderModel[]>;
  listSessions(workspace: string, page: ProviderPage): Promise<ProviderSessionSummary[]>;
  readSession(sessionId: string, page: ProviderPage): Promise<DelegationEvent[]>;
  delegate(req: DelegationRequest): Promise<DelegationResult>;
  cancel(handle: DelegationHandle): Promise<void>;
}

/** 第 4 级只读探测的额外能力：直读对方私有存储。 */
export interface StoreProbe {
  readonly providerId: string;
  locate(workspace: string): Promise<string | null>;
  listSessions(workspace: string, page: ProviderPage): Promise<ProviderSessionSummary[]>;
  /**
   * 读一次历史的正文。第 4 级也能读，因为它是只读操作；
   * `dispatch_task` 的 `session_id` 恢复性验证就是靠它。
   */
  readSession(sessionId: string, page: ProviderPage): Promise<DelegationEvent[]>;
}
