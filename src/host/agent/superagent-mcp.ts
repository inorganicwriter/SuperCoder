/**
 * 内置本地 MCP 编排桥接服务端（仅面向担任 Superagent 的外部 Agent 临时开放）。
 *
 * - 通过 Node `http` + MCP Streamable HTTP（无状态模式）暴露 `ToolRegistry` 中的全部内置工具。
 * - 每次外部 Superagent 回合分配唯一一次性 Bearer Token；`dispose()` 后立即失效。
 * - 默认绑定 `127.0.0.1:0`；仅当外层显式要求 `forDocker: true` 时懒启动宿主机桥接端点供容器通过
 *   `http://host.docker.internal:<port>/mcp` 访问。
 * - 在工具入口处强制阻止 `dispatch_task` 递归自派发给当前 `superagentId`。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type net from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { SuperagentMcpEndpoint } from "../../shared/domain/delegation.js";
import type { Logger } from "../boot/logger.js";
import { messageOf } from "../boot/failure.js";
import type { SessionHandle } from "../session/handle.js";
import type { ToolPipeline } from "../tools/pipeline.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface SuperagentTurnBridgeContext {
  readonly session: SessionHandle;
  readonly workspacePath: string;
  readonly superagentId: string;
  readonly signal: AbortSignal;
  readonly onUncertain: () => void;
}

export interface SuperagentMcpBridgeDeps {
  readonly registry: ToolRegistry;
  readonly pipeline: ToolPipeline;
  readonly logger: Logger;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export class SuperagentMcpBridge {
  private localServer: http.Server | null = null;
  private localPort = 0;
  private localStartPromise: Promise<number> | null = null;

  private dockerServer: http.Server | null = null;
  private dockerPort = 0;
  private dockerStartPromise: Promise<number> | null = null;

  private readonly scopes = new Map<string, SuperagentTurnBridgeContext>();
  private readonly activeSockets = new Set<net.Socket>();

  constructor(private readonly deps: SuperagentMcpBridgeDeps) {}

  private createHttpServer(): http.Server {
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on("connection", (socket) => {
      this.activeSockets.add(socket);
      socket.once("close", () => {
        this.activeSockets.delete(socket);
      });
    });
    return server;
  }

  private async listenOn(
    host: string,
    getPort: () => number,
    setPort: (port: number) => void,
    getServer: () => http.Server | null,
    setServer: (server: http.Server | null) => void,
    getPromise: () => Promise<number> | null,
    setPromise: (promise: Promise<number> | null) => void,
  ): Promise<number> {
    const existing = getPort();
    if (getServer() !== null && existing > 0) return existing;
    const inflight = getPromise();
    if (inflight !== null) return inflight;

    const promise = new Promise<number>((resolve, reject) => {
      const server = this.createHttpServer();
      server.once("error", (error) => {
        if (getPort() === 0) {
          setPromise(null);
          reject(error);
        }
      });
      server.listen(0, host, () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          setPromise(null);
          reject(new Error("无法监听 Superagent MCP 桥接端口"));
          return;
        }
        setServer(server);
        setPort(address.port);
        resolve(address.port);
      });
    });
    setPromise(promise);
    return promise;
  }

  async start(): Promise<number> {
    return this.listenOn(
      "127.0.0.1",
      () => this.localPort,
      (p) => { this.localPort = p; },
      () => this.localServer,
      (s) => { this.localServer = s; },
      () => this.localStartPromise,
      (p) => { this.localStartPromise = p; },
    );
  }

  async startDocker(): Promise<number> {
    return this.listenOn(
      "0.0.0.0",
      () => this.dockerPort,
      (p) => { this.dockerPort = p; },
      () => this.dockerServer,
      (s) => { this.dockerServer = s; },
      () => this.dockerStartPromise,
      (p) => { this.dockerStartPromise = p; },
    );
  }

  registerTurn(ctx: SuperagentTurnBridgeContext, options: { readonly forDocker?: boolean } = {}): {
    readonly endpoint: SuperagentMcpEndpoint;
    readonly dispose: () => void;
  } {
    const forDocker = options.forDocker === true;
    const port = forDocker ? this.dockerPort : this.localPort;
    if (port <= 0) {
      throw new Error("SuperagentMcpBridge 尚未启动");
    }
    const bearerToken = randomBytes(32).toString("hex");
    this.scopes.set(bearerToken, ctx);
    const host = forDocker ? "host.docker.internal" : "127.0.0.1";
    return {
      endpoint: {
        name: "supercoder",
        url: `http://${host}:${port}/mcp`,
        bearerToken,
      },
      dispose: () => {
        this.scopes.delete(bearerToken);
      },
    };
  }

  private authenticate(header: string | undefined): SuperagentTurnBridgeContext | null {
    if (header === undefined) return null;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) return null;
    const candidateDigest = sha256(match[1]!);
    let matched: SuperagentTurnBridgeContext | null = null;
    for (const [token, ctx] of this.scopes.entries()) {
      const tokenDigest = sha256(token);
      if (timingSafeEqual(candidateDigest, tokenDigest)) {
        matched = ctx;
      }
    }
    return matched;
  }

  private createMcpServer(ctx: SuperagentTurnBridgeContext): Server {
    const server = new Server(
      { name: "supercoder-orchestrator", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.deps.registry.specs().map((spec) => ({
        name: spec.name,
        description: spec.description,
        inputSchema: {
          type: "object" as const,
          ...spec.parameters,
        },
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = request.params.arguments ?? {};
      const argsRecord = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
      if (name === "dispatch_task" && argsRecord["agent_id"] === ctx.superagentId) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "error",
                code: "denied",
                message: `当前会话已由 ${ctx.superagentId} 作为 Superagent 直接执行，禁止递归自派发给自身；请直接处理或派发给其他外部 Agent。`,
                retryable: false,
              }),
            },
          ],
        };
      }

      const { outcome } = await this.deps.pipeline.run({
        session: ctx.session,
        workspaceId: ctx.session.meta.workspace,
        workspacePath: ctx.workspacePath,
        mode: "write",
        name,
        args,
        signal: ctx.signal,
      });
      if (outcome.status === "uncertain") {
        ctx.onUncertain();
      }
      if (outcome.status === "ok") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(outcome.value ?? {}) }],
        };
      }
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
      };
    });

    return server;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const ctx = this.authenticate(req.headers["authorization"]);
    if (ctx === null) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const server = this.createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport();
    res.once("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      this.deps.logger.warn({ error: messageOf(error) }, "Superagent MCP 桥接请求处理失败");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    }
  }

  async close(): Promise<void> {
    this.scopes.clear();
    const local = this.localServer;
    const docker = this.dockerServer;
    this.localServer = null;
    this.localPort = 0;
    this.localStartPromise = null;
    this.dockerServer = null;
    this.dockerPort = 0;
    this.dockerStartPromise = null;
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();
    await Promise.all([
      local === null ? Promise.resolve() : new Promise<void>((resolve) => { local.close(() => resolve()); }),
      docker === null ? Promise.resolve() : new Promise<void>((resolve) => { docker.close(() => resolve()); }),
    ]);
  }
}
