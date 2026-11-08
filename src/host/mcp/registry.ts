/**
 * MCP 服务器注册表。遵循架构设计规范（mcp.*）、。
 *
 * 配置存在 settings.json（同一份 `fields` 守卫）；连接是运行时状态，不落盘。
 * 连接失败不抛出到界面崩掉：写进 `lastError`，用户看得见、可以重试。
 */

import type { McpServer, McpServerInput } from "../../shared/domain/mcp.js";
import type { Logger } from "../boot/logger.js";
import { messageOf } from "../boot/failure.js";
import type { Settings, SettingsStore } from "../boot/config.js";
import type { SecretStore } from "../boot/secrets.js";
import { connectMcp, type McpConnection, type McpToolInfo } from "./client.js";
import { buildAuthorizationUrl } from "./oauth.js";

interface ConnState {
  readonly connection: McpConnection | null;
  readonly connected: boolean | null;
  readonly lastError: string | null;
}

export interface McpRegistryDeps {
  readonly settings: SettingsStore;
  readonly secrets: SecretStore;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
}

export class McpRegistry {
  private settings: Settings;
  private readonly states = new Map<string, ConnState>();

  constructor(private readonly deps: McpRegistryDeps) {
    const loaded = deps.settings.load();
    this.settings = loaded.ok ? loaded.value : {
      language: "zh-CN",
      defaultModel: null,
      approvalPolicy: "ask",
      verificationCommand: "git status --porcelain",
      mcpServers: [],
      models: [],
    };
    for (const server of this.settings.mcpServers) {
      this.states.set(server.id, { connection: null, connected: null, lastError: null });
    }
  }

  list(): McpServer[] {
    return this.settings.mcpServers.map((server) => {
      const state = this.states.get(server.id);
      return {
        ...server,
        connected: state?.connected ?? null,
        lastError: state?.lastError ?? null,
      };
    });
  }

  add(input: McpServerInput): void {
    if (this.settings.mcpServers.some((server) => server.id === input.id)) {
      throw new Error(`MCP 服务器 id 重复：${input.id}`);
    }
    this.persist({ ...this.settings, mcpServers: [...this.settings.mcpServers, input] });
    this.states.set(input.id, { connection: null, connected: null, lastError: null });
  }

  async remove(id: string): Promise<void> {
    const state = this.states.get(id);
    if (state?.connection != null) await state.connection.close().catch(() => undefined);
    this.states.delete(id);
    this.persist({
      ...this.settings,
      mcpServers: this.settings.mcpServers.filter((server) => server.id !== id),
    });
  }

  /** 连一个服务器。失败写进 lastError，不抛出。 */
  async connect(id: string): Promise<McpServer> {
    const server = this.settings.mcpServers.find((candidate) => candidate.id === id);
    if (server === undefined) throw new Error(`没有这个 MCP 服务器：${id}`);
    const token = server.oauthSecretKey === undefined ? null : this.deps.secrets.get(server.oauthSecretKey);
    try {
      const connection = await connectMcp(server, { oauthToken: token, logger: this.deps.logger });
      const previous = this.states.get(id)?.connection ?? null;
      if (previous !== null) await previous.close().catch(() => undefined);
      this.states.set(id, { connection, connected: true, lastError: null });
    } catch (error) {
      this.states.set(id, { connection: null, connected: false, lastError: messageOf(error) });
    }
    const listed = this.list().find((candidate) => candidate.id === id);
    if (listed === undefined) throw new Error(`服务器 ${id} 在连接后消失了`);
    return listed;
  }

  /** 启动时尽力而为地连上所有启用的服务器。 */
  async connectEnabled(): Promise<void> {
    for (const server of this.settings.mcpServers) {
      if (!server.enabled) continue;
      await this.connect(server.id).catch(() => undefined);
    }
  }

  async authorizationUrl(id: string): Promise<string> {
    const server = this.settings.mcpServers.find((candidate) => candidate.id === id);
    if (server === undefined) throw new Error(`没有这个 MCP 服务器：${id}`);
    if (server.transport !== "http") {
      throw new Error(`${server.label} 是本机 stdio 服务器，不需要 OAuth 授权。`);
    }
    const request = await buildAuthorizationUrl(server.target, this.deps.fetchImpl ?? fetch);
    return request.url;
  }

  /** 所有已连接服务器的工具，供模型侧使用。 */
  async tools(): Promise<Array<McpToolInfo & { readonly serverId: string }>> {
    const all: Array<McpToolInfo & { readonly serverId: string }> = [];
    for (const [id, state] of this.states) {
      if (state.connection === null) continue;
      try {
        const tools = await state.connection.listTools();
        for (const tool of tools) all.push({ ...tool, serverId: id });
      } catch (error) {
        this.deps.logger.warn({ server: id, error: messageOf(error) }, "列 MCP 工具失败");
      }
    }
    return all;
  }

  async callTool(serverId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const state = this.states.get(serverId);
    if (state?.connection == null) {
      throw new Error(`MCP 服务 ${serverId} 尚未连接。`);
    }
    return state.connection.callTool(name, args);
  }

  async close(): Promise<void> {
    for (const state of this.states.values()) {
      if (state.connection !== null) await state.connection.close().catch(() => undefined);
    }
    this.states.clear();
  }

  private persist(next: Settings): void {
    const saved = this.deps.settings.save(next);
    if (!saved.ok) throw new Error(saved.error.message);
    this.settings = next;
  }
}
