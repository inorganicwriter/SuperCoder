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
import { sanitizedEnv } from "../boot/exec.js";
import { messageOf } from "../boot/failure.js";
import type { Logger } from "../boot/logger.js";

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
}

export async function connectMcp(
  server: McpServerInput,
  options: ConnectOptions,
): Promise<McpConnection> {
  const client = new Client({ name: "supercoder", version: "0.1.0" }, { capabilities: {} });

  try {
    if (server.transport === "stdio") {
      const transport = new StdioClientTransport({
        command: server.target,
        args: [...server.args],
        env: stringEnv(sanitizedEnv()),
        stderr: "ignore",
      });
      await client.connect(transport);
    } else {
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
      await client.close();
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
