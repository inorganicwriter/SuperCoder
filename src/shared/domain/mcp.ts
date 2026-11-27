/**
 * MCP 服务器配置。遵循架构设计规范。
 *
 * 传输只有两种：本机 stdio 与 http（含 OAuth）。第一期不做 SSE 之外的推流。
 */

import { z } from "zod";
import { EnvKeySchema, NetworkModeSchema, isValidProxyUrl } from "./sandbox.js";

export const McpTransportSchema = z.enum(["stdio", "http"]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpSandboxSchema = z
  .object({
    networkMode: NetworkModeSchema.default("inherit"),
    proxyUrl: z
      .string()
      .trim()
      .max(2048)
      .optional()
      .refine((value) => value === undefined || value === "" || isValidProxyUrl(value), {
        message: "代理地址必须是合法的 http://、https:// 或 socks5:// URL",
      }),
    env: z.record(EnvKeySchema, z.string().max(8192)).optional(),
    secretEnvKeys: z.array(EnvKeySchema).max(50).optional(),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.networkMode === "proxy" && (cfg.proxyUrl === undefined || cfg.proxyUrl.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proxyUrl"],
        message: "选择独立代理模式时必须填写代理地址",
      });
    }
  });
export type McpSandbox = z.infer<typeof McpSandboxSchema>;

const McpServerInputBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  transport: McpTransportSchema,
  /** stdio：可执行文件；http：URL。 */
  target: z.string().min(1),
  args: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  /** 需要 OAuth 时，授权后把 token 存进 secrets.bin 的这个键。 */
  oauthSecretKey: z.string().optional(),
  sandbox: McpSandboxSchema.optional(),
});

export const McpServerInputSchema = McpServerInputBaseSchema.superRefine((server, ctx) => {
  if (
    server.transport === "http" &&
    server.sandbox !== undefined &&
    (server.sandbox.networkMode === "proxy" || server.sandbox.networkMode === "direct")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sandbox", "networkMode"],
      message: "HTTP 类型 MCP 仅支持继承默认或离线模式，代理/直连与环境变量隔离仅适用于 stdio 类型",
    });
  }
});
export type McpServerInput = z.infer<typeof McpServerInputSchema>;

export const McpServerSchema = McpServerInputBaseSchema.extend({
  /** 最近一次连接的结果：null 表示还没连过。 */
  connected: z.boolean().nullable(),
  lastError: z.string().nullable(),
});
export type McpServer = z.infer<typeof McpServerSchema>;
