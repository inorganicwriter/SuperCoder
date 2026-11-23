/**
 * MCP 工具桥接：把已连接 MCP 服务的工具接入统一工具流水线与模型上下文。
 *
 * 命名空间采用 `mcp__<serverId>__<toolName>`，与 8 个内置工具隔离；
 * 默认视为可变操作（mutating: true），受只读限制与统一审批策略保护。
 */

import { messageOf } from "../boot/failure.js";
import type { Logger } from "../boot/logger.js";
import { toolError, toolOk } from "../tools/outcome.js";
import type { ExternalToolSource, ExternalToolSpec, ToolContext } from "../tools/registry.js";
import type { McpRegistry } from "./registry.js";

type McpBackend = Pick<McpRegistry, "tools" | "callTool">;

interface RegisteredMcpTool {
  readonly serverId: string;
  readonly toolName: string;
  readonly spec: ExternalToolSpec;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned === "" ? "tool" : cleaned;
}

function normalizeParameters(inputSchema: unknown): Record<string, unknown> {
  if (typeof inputSchema === "object" && inputSchema !== null && !Array.isArray(inputSchema)) {
    const record = inputSchema as Record<string, unknown>;
    if (record["type"] === "object") {
      return {
        ...record,
        ...(record["properties"] === undefined ? { properties: {} } : {}),
      };
    }
  }
  return { type: "object", properties: {} };
}

function extractErrorText(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return "";
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null) {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string" && text.trim() !== "") parts.push(text.trim());
    }
  }
  return parts.join("\n");
}

export function createMcpToolSource(mcp: McpBackend, logger: Logger): ExternalToolSource {
  const index = new Map<string, RegisteredMcpTool>();

  const allocateName = (serverId: string, toolName: string): string => {
    const base = `mcp__${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`;
    if (!index.has(base)) return base;
    let suffix = 2;
    while (index.has(`${base}_${String(suffix)}`)) suffix += 1;
    return `${base}_${String(suffix)}`;
  };

  return {
    async listSpecs(): Promise<ExternalToolSpec[]> {
      const discovered = await mcp.tools();
      index.clear();
      const specs: ExternalToolSpec[] = [];
      for (const tool of discovered) {
        const exposedName = allocateName(tool.serverId, tool.name);
        const spec: ExternalToolSpec = {
          name: exposedName,
          description: tool.description || `MCP tool ${tool.name} from ${tool.serverId}`,
          parameters: normalizeParameters(tool.inputSchema),
          mutating: true,
        };
        index.set(exposedName, {
          serverId: tool.serverId,
          toolName: tool.name,
          spec,
        });
        specs.push(spec);
      }
      return specs;
    },

    getSpec(name: string): ExternalToolSpec | null {
      return index.get(name)?.spec ?? null;
    },

    async execute(name: string, args: unknown, _ctx: ToolContext) {
      const entry = index.get(name);
      if (entry === undefined) {
        return toolError("unknown_tool", `未找到 MCP 工具：${name}。`, true);
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        return toolError("invalid_args", `${name} 参数必须是 JSON 对象。`, true);
      }
      try {
        const result = await mcp.callTool(
          entry.serverId,
          entry.toolName,
          args as Record<string, unknown>,
        );
        if (typeof result === "object" && result !== null && (result as { isError?: unknown }).isError === true) {
          const detail = extractErrorText(result) || "MCP 工具返回了错误状态。";
          return toolError("failed", detail, true);
        }
        return toolOk(result);
      } catch (error) {
        const message = messageOf(error);
        logger.warn({ serverId: entry.serverId, tool: entry.toolName, error: message }, "调用 MCP 工具失败");
        return toolError("failed", `MCP 工具执行失败：${message}`, true);
      }
    },
  };
}
