/**
 * 主控 Superagent 配置：指定由模型档案还是外部 Agent 担任主对话协调者。
 */

import { z } from "zod";

export const SuperagentConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model") }),
  z.object({ kind: z.literal("agent"), agentId: z.string().min(1) }),
]);
export type SuperagentConfig = z.infer<typeof SuperagentConfigSchema>;

export const DEFAULT_SUPERAGENT_CONFIG: SuperagentConfig = { kind: "model" };
