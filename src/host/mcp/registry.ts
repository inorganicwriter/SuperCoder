/**
 * MCP 服务器注册表。遵循架构设计规范（mcp.*）、。
 *
 * 配置存在 settings.json（同一份 `fields` 守卫）；连接是运行时状态，不落盘。
 * 连接失败不抛出到界面崩掉：写进 `lastError`，用户看得见、可以重试。
 */

import type { McpServer, McpServerInput } from "../../shared/domain/mcp.js";
import { isSensitiveEnvKey } from "../../shared/domain/sandbox.js";
import type { Logger } from "../boot/logger.js";
import { messageOf } from "../boot/failure.js";
import type { Settings, SettingsStore } from "../boot/config.js";
import type { SecretStore } from "../boot/secrets.js";
import type { AgentNetworkProxy } from "../delegation/network-proxy.js";
import { connectMcp, type McpConnection, type McpToolInfo } from "./client.js";
import { buildAuthorizationUrl } from "./oauth.js";

function mcpSecretKey(serverId: string, envKey: string): string {
  return `mcp-env:${serverId}:${envKey}`;
}

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
  readonly networkProxy?: AgentNetworkProxy;
}

export class McpRegistry {
  private settings: Settings;
  private readonly states = new Map<string, ConnState>();
  private readonly connecting = new Map<string, Promise<McpServer>>();

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
    let normalized = input;
    const writtenSecretKeys: string[] = [];
    try {
      if (input.sandbox !== undefined) {
        const plainEnv: Record<string, string> = {};
        const secretKeys = new Set<string>(input.sandbox.secretEnvKeys ?? []);
        for (const [key, value] of Object.entries(input.sandbox.env ?? {})) {
          if (isSensitiveEnvKey(key)) {
            const secretId = mcpSecretKey(input.id, key);
            const saved = this.deps.secrets.set(secretId, value);
            if (!saved.ok) throw new Error(saved.error);
            writtenSecretKeys.push(secretId);
            secretKeys.add(key);
          } else {
            plainEnv[key] = value;
          }
        }
        normalized = {
          ...input,
          sandbox: {
            networkMode: input.sandbox.networkMode,
            ...(input.sandbox.proxyUrl === undefined ? {} : { proxyUrl: input.sandbox.proxyUrl }),
            ...(Object.keys(plainEnv).length > 0 ? { env: plainEnv } : {}),
            ...(secretKeys.size > 0 ? { secretEnvKeys: [...secretKeys].sort() } : {}),
          },
        };
      }
      this.persist({ ...this.settings, mcpServers: [...this.settings.mcpServers, normalized] });
    } catch (error) {
      for (const secretId of writtenSecretKeys) {
        this.deps.secrets.clear(secretId);
      }
      throw error;
    }
    this.states.set(normalized.id, { connection: null, connected: null, lastError: null });
  }

  async remove(id: string): Promise<void> {
    const existing = this.settings.mcpServers.find((server) => server.id === id);
    const state = this.states.get(id);
    if (state?.connection != null) await state.connection.close().catch(() => undefined);
    this.states.delete(id);
    for (const key of existing?.sandbox?.secretEnvKeys ?? []) {
      this.deps.secrets.clear(mcpSecretKey(id, key));
    }
    this.persist({
      ...this.settings,
      mcpServers: this.settings.mcpServers.filter((server) => server.id !== id),
    });
  }

  /** 连一个服务器。失败写进 lastError，不抛出；并发对同一 ID 复用在途连接。 */
  async connect(id: string): Promise<McpServer> {
    const inflight = this.connecting.get(id);
    if (inflight !== undefined) return inflight;
    const task = this.doConnect(id).finally(() => {
      this.connecting.delete(id);
    });
    this.connecting.set(id, task);
    return task;
  }

  private async doConnect(id: string): Promise<McpServer> {
    const server = this.settings.mcpServers.find((candidate) => candidate.id === id);
    if (server === undefined) throw new Error(`没有这个 MCP 服务器：${id}`);
    const token = server.oauthSecretKey === undefined ? null : this.deps.secrets.get(server.oauthSecretKey);
    const secretEnv: Record<string, string> = {};
    for (const key of server.sandbox?.secretEnvKeys ?? []) {
      const value = this.deps.secrets.get(mcpSecretKey(server.id, key));
      if (value !== null) secretEnv[key] = value;
    }
    try {
      const connection = await connectMcp(server, {
        oauthToken: token,
        logger: this.deps.logger,
        ...(Object.keys(secretEnv).length === 0 ? {} : { secretEnv }),
        ...(this.deps.networkProxy === undefined ? {} : { networkProxy: this.deps.networkProxy }),
      });
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
    if (server.sandbox?.networkMode === "offline") {
      throw new Error("当前 MCP 服务已配置为离线模式，禁止发起 OAuth 远程授权。");
    }
    const request = await buildAuthorizationUrl(server.target, this.deps.fetchImpl ?? fetch);
    return request.url;
  }

  /** 所有已连接服务器的工具，供模型侧使用。尚未尝试连接的已启用服务会按需懒连接一次。 */
  async tools(): Promise<Array<McpToolInfo & { readonly serverId: string }>> {
    for (const server of this.settings.mcpServers) {
      if (!server.enabled) continue;
      const state = this.states.get(server.id);
      if (state?.connected === null) {
        await this.connect(server.id).catch(() => undefined);
      }
    }
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
