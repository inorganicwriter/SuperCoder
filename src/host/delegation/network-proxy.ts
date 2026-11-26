/**
 * Host 内置轻量级按 Agent 鉴权的本地网络代理网关。
 *
 * 作用：
 * - 统一收口需要域名白名单 / 黑名单 / 离线模式 / SOCKS5 转 HTTP 代理的子进程流量
 * - 按一次性代理凭据识别具体是哪个 Agent 发起的连接，互不干扰
 * - 拦截时回调 `onBlocked(host)` 并返回 403，让界面可以提示被拦截的域名
 * - 提供单 Agent 网络连通性测试探针（`testNetwork`）
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import {
  matchHostPattern,
  type AgentSandboxProfile,
  type SandboxNetwork,
  type SandboxTestResult,
} from "../../shared/domain/sandbox.js";

interface ProxyScope {
  readonly agentId: string;
  readonly network: SandboxNetwork;
  readonly onBlocked?: (host: string) => void;
}

export interface HostPolicyVerdict {
  readonly allowed: boolean;
  readonly reason?: string;
}

export function evaluateHostPolicy(host: string, network: SandboxNetwork): HostPolicyVerdict {
  if (network.mode === "offline") {
    return { allowed: false, reason: "离线模式禁止所有出网访问" };
  }
  if (network.denylist.some((pattern) => matchHostPattern(host, pattern))) {
    return { allowed: false, reason: `域名 ${host} 命中禁止列表` };
  }
  if (network.allowlist.length > 0 && !network.allowlist.some((pattern) => matchHostPattern(host, pattern))) {
    return { allowed: false, reason: `域名 ${host} 不在允许白名单中` };
  }
  return { allowed: true };
}

export function resolveUpstreamProxy(targetHost: string, network: SandboxNetwork): string | null {
  if (network.noProxy.some((pattern) => matchHostPattern(targetHost, pattern))) {
    return null;
  }
  if (network.mode === "offline" || network.mode === "direct") {
    return null;
  }
  if (network.mode === "proxy") {
    const trimmed = network.proxyUrl?.trim() ?? "";
    return trimmed === "" ? null : trimmed;
  }
  // inherit: 读取宿主机当前代理环境，同时尊重宿主 NO_PROXY
  const hostNoProxy = (process.env["NO_PROXY"] ?? process.env["no_proxy"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (hostNoProxy.some((pattern) => matchHostPattern(targetHost, pattern))) {
    return null;
  }
  const inherited =
    process.env["HTTPS_PROXY"] ??
    process.env["https_proxy"] ??
    process.env["HTTP_PROXY"] ??
    process.env["http_proxy"] ??
    process.env["ALL_PROXY"] ??
    process.env["all_proxy"] ??
    "";
  return inherited.trim() === "" ? null : inherited.trim();
}

export class AgentNetworkProxy {
  private server: http.Server | null = null;
  private boundPort = 0;
  private startPromise: Promise<number> | null = null;
  private dockerServer: http.Server | null = null;
  private dockerBoundPort = 0;
  private dockerStartPromise: Promise<number> | null = null;
  private readonly scopes = new Map<string, ProxyScope>();
  private readonly activeSockets = new Set<net.Socket>();

  private createProxyServer(): http.Server {
    const server = http.createServer((req, res) => {
      void this.handleHttpRequest(req, res);
    });
    server.on("connect", (req, clientSocket, head) => {
      if (clientSocket instanceof net.Socket) {
        this.trackSocket(clientSocket);
        void this.handleConnect(req, clientSocket, head);
      } else {
        clientSocket.destroy();
      }
    });
    server.on("connection", (socket) => {
      this.trackSocket(socket);
    });
    return server;
  }

  async start(): Promise<number> {
    if (this.server !== null && this.boundPort > 0) return this.boundPort;
    if (this.startPromise !== null) return this.startPromise;

    this.startPromise = new Promise<number>((resolve, reject) => {
      const server = this.createProxyServer();
      server.on("error", (error) => {
        if (this.boundPort === 0) {
          this.startPromise = null;
          reject(error);
        }
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          this.startPromise = null;
          reject(new Error("无法绑定本地代理端口"));
          return;
        }
        this.server = server;
        this.boundPort = address.port;
        resolve(address.port);
      });
    });

    return this.startPromise;
  }

  /** 按需为 Docker 容器暴露受单次随机令牌保护的代理网关端口（绑定 0.0.0.0）。 */
  async startDockerGateway(): Promise<number> {
    if (this.dockerServer !== null && this.dockerBoundPort > 0) return this.dockerBoundPort;
    if (this.dockerStartPromise !== null) return this.dockerStartPromise;

    this.dockerStartPromise = new Promise<number>((resolve, reject) => {
      const server = this.createProxyServer();
      server.on("error", (error) => {
        if (this.dockerBoundPort === 0) {
          this.dockerStartPromise = null;
          reject(error);
        }
      });
      server.listen(0, "0.0.0.0", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          this.dockerStartPromise = null;
          reject(new Error("无法绑定 Docker 代理网关端口"));
          return;
        }
        this.dockerServer = server;
        this.dockerBoundPort = address.port;
        resolve(address.port);
      });
    });

    return this.dockerStartPromise;
  }

  get port(): number {
    return this.boundPort;
  }

  get dockerPort(): number {
    return this.dockerBoundPort;
  }

  registerScope(input: {
    readonly agentId: string;
    readonly network: SandboxNetwork;
    readonly forDocker?: boolean;
    readonly onBlocked?: (host: string) => void;
  }): { readonly proxyUrl: string; readonly dispose: () => void } {
    const port = input.forDocker === true ? this.dockerBoundPort : this.boundPort;
    if (port <= 0) {
      throw new Error("AgentNetworkProxy 尚未启动");
    }
    const token = randomBytes(24).toString("hex");
    this.scopes.set(token, {
      agentId: input.agentId,
      network: input.network,
      ...(input.onBlocked === undefined ? {} : { onBlocked: input.onBlocked }),
    });
    const host = input.forDocker === true ? "host.docker.internal" : "127.0.0.1";
    const proxyUrl = `http://${encodeURIComponent(input.agentId)}:${token}@${host}:${port}`;
    return {
      proxyUrl,
      dispose: () => {
        this.scopes.delete(token);
      },
    };
  }

  async close(): Promise<void> {
    this.scopes.clear();
    const server = this.server;
    const dockerServer = this.dockerServer;
    this.server = null;
    this.boundPort = 0;
    this.startPromise = null;
    this.dockerServer = null;
    this.dockerBoundPort = 0;
    this.dockerStartPromise = null;
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();
    await Promise.all([
      server === null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      dockerServer === null
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            dockerServer.close(() => resolve());
          }),
    ]);
  }

  async testNetwork(
    profile: AgentSandboxProfile,
    targetUrl: string,
    timeoutMs = 8000,
  ): Promise<SandboxTestResult> {
    let url: URL;
    try {
      url = new URL(targetUrl);
    } catch {
      return {
        ok: false,
        target: targetUrl,
        mode: profile.network.mode,
        message: "目标地址不是合法的 URL",
      };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        ok: false,
        target: targetUrl,
        mode: profile.network.mode,
        message: "仅支持测试 http:// 或 https:// 地址",
      };
    }

    const policy = evaluateHostPolicy(url.hostname, profile.network);
    if (!policy.allowed) {
      return {
        ok: false,
        target: targetUrl,
        mode: profile.network.mode,
        blockedByRule: true,
        message: policy.reason ?? "已被网络规则拦截",
      };
    }

    const startedAt = Date.now();
    const port = url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    const targetHost = stripIpv6Brackets(url.hostname);
    const upstream = resolveUpstreamProxy(targetHost, profile.network);

    let ca: string | undefined;
    if (profile.network.caCertPath && profile.network.caCertPath.trim() !== "") {
      try {
        ca = readFileSync(profile.network.caCertPath.trim(), "utf8");
      } catch (error) {
        return {
          ok: false,
          target: targetUrl,
          mode: profile.network.mode,
          message: `读取 CA 证书失败：${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    let rawSocket: net.Socket | null = null;
    let transportSocket: net.Socket | tls.TLSSocket | null = null;
    try {
      // 纯 http:// 经 HTTP/HTTPS 上游代理时直接发 HEAD http://...，避免上游代理禁止 CONNECT :80
      if (url.protocol === "http:" && upstream !== null && /^https?:/i.test(upstream)) {
        const upstreamUrl = new URL(upstream);
        const isTlsUpstream = upstreamUrl.protocol === "https:";
        const upstreamPort = upstreamUrl.port !== "" ? Number(upstreamUrl.port) : isTlsUpstream ? 443 : 80;
        const upstreamHost = stripIpv6Brackets(upstreamUrl.hostname);
        rawSocket = await connectRawTcpOrTls(upstreamHost, upstreamPort, isTlsUpstream, timeoutMs, ca);
        transportSocket = rawSocket;
        const statusCode = await probeHttpHeadViaHttpUpstream(rawSocket, url, upstreamUrl, timeoutMs);
        const latencyMs = Math.max(1, Date.now() - startedAt);
        return {
          ok: true,
          target: targetUrl,
          mode: profile.network.mode,
          latencyMs,
          statusCode,
          message: `连通正常（HTTP ${statusCode}，${latencyMs} ms）`,
        };
      }
      rawSocket = await connectTarget(targetHost, port, upstream, timeoutMs);
      if (url.protocol === "https:") {
        transportSocket = await upgradeTls(rawSocket, targetHost, ca, timeoutMs);
      } else {
        transportSocket = rawSocket;
      }
      const statusCode = await probeHttpHead(transportSocket, url, timeoutMs);
      const latencyMs = Math.max(1, Date.now() - startedAt);
      return {
        ok: true,
        target: targetUrl,
        mode: profile.network.mode,
        latencyMs,
        statusCode,
        message: `连通正常（HTTP ${statusCode}，${latencyMs} ms）`,
      };
    } catch (error) {
      return {
        ok: false,
        target: targetUrl,
        mode: profile.network.mode,
        latencyMs: Date.now() - startedAt,
        message: `连接失败：${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      transportSocket?.destroy();
      if (rawSocket !== null && rawSocket !== transportSocket) rawSocket.destroy();
    }
  }

  private trackSocket(socket: net.Socket): void {
    this.activeSockets.add(socket);
    socket.once("close", () => {
      this.activeSockets.delete(socket);
    });
  }

  private authenticate(header: string | undefined): ProxyScope | null {
    if (header === undefined) return null;
    const match = /^Basic\s+(.+)$/i.exec(header.trim());
    if (match === null) return null;
    let decoded: string;
    try {
      decoded = Buffer.from(match[1]!, "base64").toString("utf8");
    } catch {
      return null;
    }
    const sep = decoded.indexOf(":");
    if (sep < 0) return null;
    const token = decoded.slice(sep + 1);
    return this.scopes.get(token) ?? null;
  }

  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const scope = this.authenticate(req.headers["proxy-authorization"]);
    if (scope === null) {
      clientSocket.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"SuperCoder\"\r\nConnection: close\r\n\r\n",
      );
      return;
    }

    const parsed = parseHostPort(req.url ?? "", 443);
    if (parsed === null) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }

    const verdict = evaluateHostPolicy(parsed.host, scope.network);
    if (!verdict.allowed) {
      scope.onBlocked?.(parsed.host);
      const body = `Blocked by SuperCoder sandbox: ${verdict.reason ?? parsed.host}`;
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      return;
    }

    const upstream = resolveUpstreamProxy(parsed.host, scope.network);
    let upstreamSocket: net.Socket;
    try {
      upstreamSocket = await connectTarget(parsed.host, parsed.port, upstream, 15_000);
      this.trackSocket(upstreamSocket);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      clientSocket.end(
        `HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nUpstream connection failed: ${detail}`,
      );
      return;
    }

    if (clientSocket.destroyed) {
      upstreamSocket.destroy();
      return;
    }

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstreamSocket.write(head);

    const tearDown = (): void => {
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };
    clientSocket.on("error", tearDown);
    upstreamSocket.on("error", tearDown);
    clientSocket.on("close", () => {
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    });
    upstreamSocket.on("close", () => {
      if (!clientSocket.destroyed) clientSocket.destroy();
    });
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const scope = this.authenticate(req.headers["proxy-authorization"]);
    if (scope === null) {
      res.writeHead(407, {
        "Proxy-Authenticate": "Basic realm=\"SuperCoder\"",
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Proxy authentication required");
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Invalid proxy request URL");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Only http:// targets are supported in plain proxy requests");
      return;
    }

    const verdict = evaluateHostPolicy(url.hostname, scope.network);
    if (!verdict.allowed) {
      scope.onBlocked?.(url.hostname);
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Blocked by SuperCoder sandbox: ${verdict.reason ?? url.hostname}`);
      return;
    }

    const port = url.port !== "" ? Number(url.port) : 80;
    const targetHost = stripIpv6Brackets(url.hostname);
    const upstream = resolveUpstreamProxy(targetHost, scope.network);
    const forwardHeaders: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (lower === "proxy-authorization" || lower === "proxy-connection" || lower === "connection") continue;
      forwardHeaders[key] = value;
    }
    forwardHeaders["host"] = url.host;
    forwardHeaders["connection"] = "close";

    // 若上游是 http/https 代理，直接转发完整 URL（比强迫上游允许 CONNECT :80 兼容性更好）。
    if (upstream !== null && (/^https?:/i.test(upstream))) {
      const upstreamUrl = new URL(upstream);
      const isTlsUpstream = upstreamUrl.protocol === "https:";
      const upstreamPort = upstreamUrl.port !== "" ? Number(upstreamUrl.port) : isTlsUpstream ? 443 : 80;
      const upstreamHost = stripIpv6Brackets(upstreamUrl.hostname);
      const auth =
        upstreamUrl.username !== "" || upstreamUrl.password !== ""
          ? `Basic ${Buffer.from(`${decodeURIComponent(upstreamUrl.username)}:${decodeURIComponent(upstreamUrl.password)}`).toString("base64")}`
          : undefined;
      if (auth !== undefined) forwardHeaders["proxy-authorization"] = auth;
      const socket = await connectRawTcpOrTls(upstreamHost, upstreamPort, isTlsUpstream, 15_000).catch((error) => {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Upstream proxy error: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (socket === null) return;
      this.trackSocket(socket);
      const out = http.request(
        {
          host: upstreamHost,
          port: upstreamPort,
          path: url.toString(),
          method: req.method ?? "GET",
          headers: forwardHeaders,
          createConnection: () => socket,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      out.on("error", (error) => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Upstream request failed: ${error.message}`);
      });
      res.once("close", () => {
        if (!res.writableEnded) out.destroy();
      });
      req.pipe(out);
      return;
    }

    let targetSocket: net.Socket;
    try {
      targetSocket = await connectTarget(targetHost, port, upstream, 15_000);
      this.trackSocket(targetSocket);
    } catch (error) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Upstream connection failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const out = http.request(
      {
        host: targetHost,
        port,
        path: `${url.pathname}${url.search}`,
        method: req.method ?? "GET",
        headers: forwardHeaders,
        createConnection: () => targetSocket,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    out.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Target request failed: ${error.message}`);
    });
    res.once("close", () => {
      if (!res.writableEnded) out.destroy();
    });
    req.pipe(out);
  }
}

function parseHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const trimmed = authority.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end <= 1) return null;
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    if (rest === "") return { host, port: defaultPort };
    if (!rest.startsWith(":")) return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon < 0) return { host: trimmed, port: defaultPort };
  const host = trimmed.slice(0, colon);
  const port = Number(trimmed.slice(colon + 1));
  if (host === "" || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

export function stripIpv6Brackets(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function encodeIpv6Bytes(ip: string): Buffer | null {
  const clean = ip.split("%")[0] ?? ip;
  const halves = clean.split("::");
  if (halves.length > 2) return null;
  const parsePart = (part: string): number[] | null => {
    if (part === "") return [];
    const tokens = part.split(":");
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i]!;
      if (token.includes(".") && i === tokens.length - 1) {
        const octets = token.split(".").map((n) => Number(n));
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        groups.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
      } else {
        const num = Number.parseInt(token, 16);
        if (Number.isNaN(num) || num < 0 || num > 0xffff) return null;
        groups.push(num);
      }
    }
    return groups;
  };
  const left = parsePart(halves[0]!);
  if (left === null) return null;
  const right = halves.length === 2 ? parsePart(halves[1]!) : [];
  if (right === null) return null;
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const full = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) out.writeUInt16BE(full[i]!, i * 2);
  return out;
}

function connectRawTcpOrTls(
  host: string,
  port: number,
  useTls: boolean,
  timeoutMs: number,
  ca?: string,
): Promise<net.Socket> {
  const cleanHost = stripIpv6Brackets(host);
  return new Promise<net.Socket>((resolve, reject) => {
    let settled = false;
    const socket: net.Socket = useTls
      ? tls.connect({
          host: cleanHost,
          port,
          servername: net.isIP(cleanHost) === 0 ? cleanHost : undefined,
          ...(ca === undefined ? {} : { ca: [...tls.rootCertificates, ca] }),
        })
      : net.connect({ host: cleanHost, port });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);
    timer.unref();

    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    const eventName = useTls ? "secureConnect" : "connect";
    socket.once("error", onError);
    socket.once(eventName, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

async function connectTarget(
  targetHost: string,
  targetPort: number,
  upstreamUrl: string | null,
  timeoutMs = 15_000,
): Promise<net.Socket> {
  if (upstreamUrl === null) {
    return connectRawTcpOrTls(targetHost, targetPort, false, timeoutMs);
  }
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol === "socks5:" || upstream.protocol === "socks5h:") {
    return connectViaSocks5(upstream, targetHost, targetPort, timeoutMs);
  }
  if (upstream.protocol === "http:" || upstream.protocol === "https:") {
    return connectViaHttpTunnel(upstream, targetHost, targetPort, timeoutMs);
  }
  throw new Error(`不支持的上游代理协议：${upstream.protocol}`);
}

async function connectViaHttpTunnel(
  upstream: URL,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const isTls = upstream.protocol === "https:";
  const upstreamPort = upstream.port !== "" ? Number(upstream.port) : isTls ? 443 : 80;
  const socket = await connectRawTcpOrTls(upstream.hostname, upstreamPort, isTls, timeoutMs);

  return new Promise<net.Socket>((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("上游代理 CONNECT 握手超时"));
    }, timeoutMs);
    timer.unref();

    const cleanup = (): void => {
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const onError = (error: Error): void => {
      if (settled) return;
      cleanup();
      socket.destroy();
      reject(error);
    };

    const onClose = (): void => {
      if (settled) return;
      cleanup();
      reject(new Error("上游代理在握手完成前关闭连接"));
    };

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (buffer.length > 16_384) {
          cleanup();
          socket.destroy();
          reject(new Error("上游代理响应头过长"));
        }
        return;
      }
      const headerText = buffer.subarray(0, headerEnd).toString("latin1");
      const statusLine = headerText.split("\r\n")[0] ?? "";
      const match = /^HTTP\/\d\.\d\s+(\d{3})/i.exec(statusLine);
      const status = match ? Number(match[1]) : 0;
      const rest = buffer.subarray(headerEnd + 4);
      cleanup();
      if (status < 200 || status >= 300) {
        socket.destroy();
        reject(new Error(`上游代理拒绝建立隧道（${statusLine || "未知响应"}）`));
        return;
      }
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);

    const hostHeader = targetHost.includes(":") ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`;
    const headers = [
      `CONNECT ${hostHeader} HTTP/1.1`,
      `Host: ${hostHeader}`,
    ];
    if (upstream.username !== "" || upstream.password !== "") {
      const cred = `${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`;
      headers.push(`Proxy-Authorization: Basic ${Buffer.from(cred).toString("base64")}`);
    }
    headers.push("Proxy-Connection: Keep-Alive", "", "");
    socket.write(headers.join("\r\n"));
  });
}

async function connectViaSocks5(
  upstream: URL,
  targetHost: string,
  targetPort: number,
  timeoutMs: number,
): Promise<net.Socket> {
  const upstreamPort = upstream.port !== "" ? Number(upstream.port) : 1080;
  const socket = await connectRawTcpOrTls(upstream.hostname, upstreamPort, false, timeoutMs);
  const hasAuth = upstream.username !== "" || upstream.password !== "";
  const userBuf = Buffer.from(decodeURIComponent(upstream.username), "utf8");
  const passBuf = Buffer.from(decodeURIComponent(upstream.password), "utf8");
  if (userBuf.length > 255 || passBuf.length > 255) {
    socket.destroy();
    throw new Error("SOCKS5 用户名或密码过长");
  }

  return new Promise<net.Socket>((resolve, reject) => {
    let settled = false;
    let stage: "greeting" | "auth" | "connect" = "greeting";
    let buffer = Buffer.alloc(0);

    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("SOCKS5 代理握手超时"));
    }, timeoutMs);
    timer.unref();

    const cleanup = (): void => {
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const failHandshake = (msg: string): void => {
      if (settled) return;
      cleanup();
      socket.destroy();
      reject(new Error(msg));
    };

    const onError = (error: Error): void => {
      if (settled) return;
      cleanup();
      socket.destroy();
      reject(error);
    };

    const onClose = (): void => {
      failHandshake("SOCKS5 代理在握手完成前关闭连接");
    };

    const sendConnect = (): void => {
      stage = "connect";
      const cleanHost = stripIpv6Brackets(targetHost);
      const ipKind = net.isIP(cleanHost);
      let addrPayload: Buffer | null = null;
      if (ipKind === 4) {
        const octets = cleanHost.split(".").map((n) => Number(n));
        addrPayload = Buffer.from([0x01, ...octets]);
      } else if (ipKind === 6) {
        const ipv6Bytes = encodeIpv6Bytes(cleanHost);
        if (ipv6Bytes !== null) addrPayload = Buffer.concat([Buffer.from([0x04]), ipv6Bytes]);
      }
      if (addrPayload === null) {
        const hostBuf = Buffer.from(cleanHost, "utf8");
        if (hostBuf.length > 255) {
          failHandshake("目标域名过长");
          return;
        }
        addrPayload = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
      }
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(targetPort, 0);
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPayload, portBuf]));
    };

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const ver = buffer[0]!;
        const method = buffer[1]!;
        buffer = buffer.subarray(2);
        if (ver !== 0x05 || method === 0xff) {
          failHandshake("SOCKS5 代理拒绝认证方式");
          return;
        }
        if (method === 0x02) {
          if (!hasAuth) {
            failHandshake("SOCKS5 代理需要用户名与密码");
            return;
          }
          stage = "auth";
          socket.write(Buffer.concat([Buffer.from([0x01, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]));
        } else if (method === 0x00) {
          sendConnect();
        } else {
          failHandshake(`不支持的 SOCKS5 认证方式：${method}`);
          return;
        }
      }

      if (stage === "auth") {
        if (buffer.length < 2) return;
        const ver = buffer[0]!;
        const status = buffer[1]!;
        buffer = buffer.subarray(2);
        if (ver !== 0x01 || status !== 0x00) {
          failHandshake("SOCKS5 用户名或密码认证失败");
          return;
        }
        sendConnect();
      }

      if (stage === "connect") {
        if (buffer.length < 4) return;
        const ver = buffer[0]!;
        const rep = buffer[1]!;
        const atyp = buffer[3]!;
        if (ver !== 0x05) {
          failHandshake("SOCKS5 响应版本无效");
          return;
        }
        let needed = 4;
        if (atyp === 0x01) needed += 4 + 2;
        else if (atyp === 0x04) needed += 16 + 2;
        else if (atyp === 0x03) {
          if (buffer.length < 5) return;
          needed += 1 + buffer[4]! + 2;
        } else {
          failHandshake(`不支持的 SOCKS5 地址类型：${atyp}`);
          return;
        }
        if (buffer.length < needed) return;
        if (rep !== 0x00) {
          failHandshake(`SOCKS5 CONNECT 失败（错误码 ${rep}）`);
          return;
        }
        const rest = buffer.subarray(needed);
        cleanup();
        if (rest.length > 0) socket.unshift(rest);
        resolve(socket);
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);

    const methods = hasAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00];
    socket.write(Buffer.from(methods));
  });
}

function upgradeTls(
  socket: net.Socket,
  servername: string,
  ca: string | undefined,
  timeoutMs: number,
): Promise<tls.TLSSocket> {
  const cleanServer = stripIpv6Brackets(servername);
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    let settled = false;
    const tlsSocket = tls.connect({
      socket,
      ...(net.isIP(cleanServer) === 0 ? { servername: cleanServer } : {}),
      ...(ca === undefined ? {} : { ca: [...tls.rootCertificates, ca] }),
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      tlsSocket.destroy();
      reject(new Error("TLS 握手超时"));
    }, timeoutMs);
    timer.unref();
    tlsSocket.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tlsSocket.destroy();
      reject(error);
    });
    tlsSocket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tlsSocket);
    });
  });
}

function probeHttpHead(
  socket: net.Socket | tls.TLSSocket,
  url: URL,
  timeoutMs: number,
): Promise<number> {
  const cleanHost = stripIpv6Brackets(url.hostname);
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: cleanHost,
        port: url.port !== "" ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
        path: `${url.pathname || "/"}${url.search}`,
        method: "HEAD",
        headers: {
          Host: url.host,
          Connection: "close",
          "User-Agent": "SuperCoder-NetworkProbe/1.0",
        },
        createConnection: () => socket,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 200);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("HTTP 探测超时"));
    });
    req.once("error", reject);
    req.end();
  });
}

function probeHttpHeadViaHttpUpstream(
  socket: net.Socket,
  targetUrl: URL,
  upstreamUrl: URL,
  timeoutMs: number,
): Promise<number> {
  const upstreamHost = stripIpv6Brackets(upstreamUrl.hostname);
  const upstreamPort =
    upstreamUrl.port !== "" ? Number(upstreamUrl.port) : upstreamUrl.protocol === "https:" ? 443 : 80;
  const headers: http.OutgoingHttpHeaders = {
    Host: targetUrl.host,
    Connection: "close",
    "User-Agent": "SuperCoder-NetworkProbe/1.0",
  };
  if (upstreamUrl.username !== "" || upstreamUrl.password !== "") {
    const cred = `${decodeURIComponent(upstreamUrl.username)}:${decodeURIComponent(upstreamUrl.password)}`;
    headers["Proxy-Authorization"] = `Basic ${Buffer.from(cred).toString("base64")}`;
  }
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        host: upstreamHost,
        port: upstreamPort,
        path: targetUrl.toString(),
        method: "HEAD",
        headers,
        createConnection: () => socket,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 200);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("HTTP 探测超时"));
    });
    req.once("error", reject);
    req.end();
  });
}
