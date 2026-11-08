/**
 * MCP 服务器配置。遵循架构设计规范。
 *
 * 传输只有两种：本机 stdio 与 http（含 OAuth）。第一期不做 SSE 之外的推流。
 */

import { z } from "zod";

export const McpTransportSchema = z.enum(["stdio", "http"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerInputSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  transport: McpTransportSchema,
  /** stdio：可执行文件；http：URL。 */
  target: z.string().min(1),
  args: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  /** 需要 OAuth 时，授权后把 token 存进 secrets.bin 的这个键。 */
  oauthSecretKey: z.string().optional(),
});
export type McpServerInput = z.infer<typeof McpServerInputSchema>;

export const McpServerSchema = McpServerInputSchema.extend({
  /** 最近一次连接的结果：null 表示还没连过。 */
  connected: z.boolean().nullable(),
  lastError: z.string().nullable(),
});
export type McpServer = z.infer<typeof McpServerSchema>;
