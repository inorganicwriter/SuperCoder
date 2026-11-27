/**
 * MCP 客户端连接。遵循架构设计规范。
 *
 * 只做"连上、列工具、调工具、断开"四件事；协议细节交给官方 SDK。
 * 连不上不隐藏：状态里写清 lastError，界面上显示"未连接"并给出下一步。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerInput } from "../../shared/domain/mcp.js";
import { AgentSandboxProfileSchema } from "../../shared/domain/sandbox.js";
import { buildSanitizedEnv, PROXY_ENV_KEYS } from "../boot/exec.js";
import { messageOf } from "../boot/failure.js";
import type { Logger } from "../boot/logger.js";
import type { AgentNetworkProxy } from "../delegation/network-proxy.js";

const PROXY_ONLY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface McpConnection {
  readonly id: string;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  readonly oauthToken?: string | null;
  readonly logger: Logger;
  readonly networkProxy?: AgentNetworkProxy;
  readonly secretEnv?: Readonly<Record<string, string>>;
}

/** 为 MCP stdio 子进程构建独立网络与脱敏环境变量；退出或失败时必须调用 `dispose()` 回收代理凭据。 */
export async function buildMcpStdioEnv(
  server: McpServerInput,
  options: { readonly networkProxy?: AgentNetworkProxy; readonly secretEnv?: Readonly<Record<string, string>> } = {},
): Promise<{ readonly env: Record<string, string>; readonly dispose: () => void }> {
  const sandbox = server.sandbox;
  const unset: string[] = [];
  const extra: Record<string, string> = {
    ...sandbox?.env,
    ...options.secretEnv,
  };
  let disposeScope: (() => void) | null = null;

  if (sandbox?.networkMode === "direct") {
    unset.push(...PROXY_ENV_KEYS);
  } else if (sandbox?.networkMode === "offline") {
    unset.push(...PROXY_ENV_KEYS);
    if (options.networkProxy !== undefined) {
      await options.networkProxy.start();
      const scope = options.networkProxy.registerScope({
        agentId: `mcp-${server.id}`,
        network: AgentSandboxProfileSchema.parse({ network: { mode: "offline" } }).network,
      });
      disposeScope = scope.dispose;
      for (const key of PROXY_ONLY_KEYS) extra[key] = scope.proxyUrl;
    } else {
      for (const key of PROXY_ONLY_KEYS) extra[key] = "http://127.0.0.1:0";
    }
  } else if (sandbox?.networkMode === "proxy" && sandbox.proxyUrl) {
    unset.push(...PROXY_ONLY_KEYS);
    if (/^socks5h?:/i.test(sandbox.proxyUrl) && options.networkProxy !== undefined) {
      await options.networkProxy.start();
      const scope = options.networkProxy.registerScope({
        agentId: `mcp-${server.id}`,
        network: AgentSandboxProfileSchema.parse({
          network: { mode: "proxy", proxyUrl: sandbox.proxyUrl },
        }).network,
      });
      disposeScope = scope.dispose;
      for (const key of PROXY_ONLY_KEYS) extra[key] = scope.proxyUrl;
    } else {
      for (const key of PROXY_ONLY_KEYS) extra[key] = sandbox.proxyUrl;
    }
  }

  const compiled = buildSanitizedEnv({ extra, unset });
  return {
    env: stringEnv(compiled),
    dispose: () => {
      disposeScope?.();
    },
  };
}

export async function connectMcp(
  server: McpServerInput,
  options: ConnectOptions,
): Promise<McpConnection> {
  const client = new Client({ name: "supercoder", version: "0.1.0" }, { capabilities: {} });
  let disposeEnv: (() => void) | null = null;

  try {
    if (server.transport === "stdio") {
      const prepared = await buildMcpStdioEnv(server, {
        ...(options.networkProxy === undefined ? {} : { networkProxy: options.networkProxy }),
        ...(options.secretEnv === undefined ? {} : { secretEnv: options.secretEnv }),
      });
      disposeEnv = prepared.dispose;
      const transport = new StdioClientTransport({
        command: server.target,
        args: [...server.args],
        env: prepared.env,
        stderr: "ignore",
      });
      await client.connect(transport);
    } else {
      if (server.sandbox?.networkMode === "offline") {
        throw new Error("当前 MCP 服务已配置为离线模式，禁止发起远程 HTTP 连接。");
      }
      if (server.sandbox?.networkMode === "proxy" || server.sandbox?.networkMode === "direct") {
        throw new Error("HTTP 类型 MCP 暂不支持独立代理/直连覆盖，请改用继承或离线模式。");
      }
      const headers: Record<string, string> =
        options.oauthToken === null || options.oauthToken === undefined
          ? {}
          : { authorization: `Bearer ${options.oauthToken}` };
      const transport = new StreamableHTTPClientTransport(new URL(server.target), {
        requestInit: { headers },
      });
      await client.connect(transport);
    }
  } catch (error) {
    disposeEnv?.();
    options.logger.warn({ server: server.id, error: messageOf(error) }, "MCP 连接失败");
    throw new Error(`${server.label} 连接失败：${messageOf(error)}。`);
  }

  return {
    id: server.id,
    async listTools() {
      const result = await client.listTools();
      return (result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      }));
    },
    async callTool(name, args) {
      return client.callTool({ name, arguments: args });
    },
    async close() {
      try {
        await client.close();
      } finally {
        disposeEnv?.();
      }
    },
  };
}

/** stdio 传输只接受 [string, string]；把 undefined 的变量滤掉。 */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
