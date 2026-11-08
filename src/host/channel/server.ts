/**
 * HTTP + WebSocket 通道。遵循架构设计规范。
 *
 * 只绑 `127.0.0.1`：静态文件（打包后的界面）与 `/ws` 走同一个端口，
 * 这样页面的 Origin 天然与 `Host` 同源， 的校验不需要为开发环境开口子。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  ClientFrameSchema,
  EVENT_BATCH_LIMIT,
  resultErr,
  type ClientFrame,
  type ServerFrame,
} from "../../shared/protocol/rpc.js";
import { isTransientEvent, type SessionEvent } from "../../shared/session/events.js";
import { messageOf } from "../boot/failure.js";
import type { Logger } from "../boot/logger.js";
import { LOOPBACK, tokenFromUrl, tokensEqual, verifyHandshake } from "./auth.js";
import {
  buildAuthUrl,
  callbackPage,
  createPendingStore,
  exchangeCode,
  randomState,
  type PendingStore,
} from "../account/google.js";
import { gitSummary, listDirectory, readPreview } from "../files/browse.js";
import type { SubscriptionHub } from "./events.js";
import type { RpcRouter } from "./rpc.js";

/** 兼容层的 WebSocket 路径。与 RPC 的 `/ws` 分开，免得两种帧混在一条连接上。 */
export const LEGACY_WS_PATH = "/legacy-ws";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface ChannelDeps {
  readonly router: RpcRouter;
  readonly hub: SubscriptionHub;
  readonly token: string;
  readonly logger: Logger;
  /** 打包后的界面目录；null 时只提供 `/ws`。 */
  readonly rendererDir: string | null;
  /** 按工作区 ID 取根目录；未知 ID 返回空串。文件栏用它做路径白名单。 */
  readonly workspaceRoot: (workspaceId: string) => string;
  /** 订阅时接线并返回 `seq > sinceSeq` 的补发事件。 */
  readonly onSubscribe: (sessionId: string, sinceSeq: number) => Promise<SessionEvent[]>;
  /** 监听端口；0 表示由系统分配。 */
  readonly port?: number;
}

export interface RunningChannel {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startChannel(deps: ChannelDeps): Promise<RunningChannel> {
  const pendingAuth = createPendingStore();
  const server = createServer((req, res) => {
    void handleHttp(req, res, deps, pendingAuth).catch((error: unknown) => {
      deps.logger.error({ error: messageOf(error) }, "处理 HTTP 请求失败");
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("内部错误\n");
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  const clients = new Set<WebSocket>();

  server.on("upgrade", (req, socket, head) => {
    const port = currentPort(server);
    const verdict = verifyHandshake({
      host: req.headers.host,
      origin: req.headers.origin,
      token: tokenFromUrl(req.url),
      expectedToken: deps.token,
      port,
    });
    if (!verdict.ok) {
      deps.logger.warn({ reason: verdict.reason }, "拒绝 WebSocket 握手");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    const subscriberId = randomUUID();
    clients.add(ws);
    const send = (frame: ServerFrame): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    ws.on("message", (raw: unknown) => {
      void handleFrame(String(raw), subscriberId, send, deps).catch((error: unknown) => {
        deps.logger.error({ error: messageOf(error) }, "处理客户端帧失败");
      });
    });
    ws.on("close", () => {
      clients.delete(ws);
      deps.hub.detachSubscriber(subscriberId);
    });
    ws.on("error", (error: Error) => {
      deps.logger.warn({ error: error.message }, "WebSocket 错误");
    });
  });

  const port = await listen(server, deps.port ?? 0);
  deps.logger.info({ port }, "通道已启动");

  return {
    port,
    url: `http://${LOOPBACK}:${port}/`,
    close: async () => {
      for (const client of clients) client.close(1001, "server shutting down");
      clients.clear();
      await new Promise<void>((done) => wss.close(() => done()));
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((done, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, LOOPBACK, () => {
      server.off("error", onError);
      done(currentPort(server));
    });
  });
}

function currentPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") return 0;
  const info = address as AddressInfo;
  return info.port;
}

async function handleFrame(
  raw: string,
  subscriberId: string,
  send: (frame: ServerFrame) => void,
  deps: ChannelDeps,
): Promise<void> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    send(resultErr("", "invalid_params", "请求帧不是合法的 JSON。与服务器通信异常。"));
    return;
  }
  const frame = ClientFrameSchema.safeParse(json);
  if (!frame.success) {
    send(resultErr("", "invalid_params", "数据帧格式不符合协议规范"));
    return;
  }
  const parsed: ClientFrame = frame.data;
  if (parsed.kind === "rpc") {
    send(await deps.router.dispatch(parsed));
    return;
  }

  deps.hub.beginBackfill(parsed.sessionId);
  deps.hub.subscribe(parsed.sessionId, { id: subscriberId, send }, parsed.sinceSeq);
  let backlog: SessionEvent[];
  try {
    backlog = await deps.onSubscribe(parsed.sessionId, parsed.sinceSeq);
  } catch (error) {
    const dropped = deps.hub.endBackfill(parsed.sessionId);
    deps.logger.warn(
      { sessionId: parsed.sessionId, dropped: dropped.length, error: messageOf(error) },
      "补发失败，缓冲的增量已丢弃，客户端会重新订阅",
    );
    send(
      resultErr(
        parsed.sessionId,
        "not_found",
        `订阅会话失败：${messageOf(error)}。`,
      ),
    );
    return;
  }
  const buffered = deps.hub.endBackfill(parsed.sessionId);
  for (let offset = 0; offset < backlog.length; offset += EVENT_BATCH_LIMIT) {
    send({
      kind: "events",
      sessionId: parsed.sessionId,
      events: backlog.slice(offset, offset + EVENT_BATCH_LIMIT),
    });
  }
  // 补发之后才推攒下的增量：先旧后新，客户端按 seq 续接不会掉事件。
  // 写日志与"读日志 + 挂监听"之间没有原子性，同一条事件可能既在 backlog 里、
  // 又在缓冲区里，所以这里按 seq 去掉重叠部分；瞬态事件不进日志、不存在重复，
  // 且借了别人的 seq，按 seq 过滤会误伤，一律保留。客户端仍会再按 seq 滤一遍，
  // 那一层是双保险，不是这条的唯一防线。
  deps.hub.publish(parsed.sessionId, dropReplayed(buffered, backlog));
}

/**
 * 去掉"已经随补发发过一遍"的持久事件。
 *
 * 判定标准是 backlog 的最大 seq：缓冲区的持久事件 seq 不大于它，说明客户端
 * 从补发里已经拿到了。瞬态事件直接保留（见 `isTransientEvent`）。
 */
function dropReplayed(buffered: readonly SessionEvent[], backlog: readonly SessionEvent[]): SessionEvent[] {
  let maxSeq = 0;
  for (const event of backlog) maxSeq = Math.max(maxSeq, event.seq);
  return buffered.filter((event) => isTransientEvent(event.type) || event.seq > maxSeq);
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ChannelDeps,
  pendingAuth: PendingStore,
): Promise<void> {
  if (await handleAuthRoute(req, res, deps, pendingAuth)) return;
  if (deps.rendererDir === null) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("SuperCoder host：未配置界面目录\n");
    return;
  }
  const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
  const pathname = decodeURIComponent(url.pathname);
  const root = resolve(deps.rendererDir);
  const requested = pathname === "/" || pathname === "" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(root, requested);
  if (!target.startsWith(root + sep) && target !== root) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("越界路径\n");
    return;
  }
  const file = pickFile(target, root);
  if (file === null) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("找不到该资源\n");
    return;
  }
  try {
    const raw = readFileSync(file);
    // TypeScript 客户端从 preload 拿端口与 token（`window.supercoder`），不需要服务端注入。
    const body = raw;
    res.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": file.endsWith("index.html") ? "no-store" : "no-cache",
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`读取失败：${messageOf(error)}\n`);
  }
}

/** 找不到实体文件时退回 index.html（前端路由）。 */
function pickFile(target: string, root: string): string | null {
  if (existsSync(target) && statSync(target).isFile()) return target;
  const fallback = resolve(root, "index.html");
  return existsSync(fallback) ? fallback : null;
}

/** 判断这次请求是不是 Google 登录的三个路由之一；是就处理完返回 true。 */
async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ChannelDeps,
  pendingAuth: PendingStore,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${LOOPBACK}`);
  if (url.pathname.startsWith("/files/") || url.pathname === "/git/status") {
  // —— 文件栏：三个只读接口，全部要令牌，路径都在工作区根之内 ——
  if (url.pathname === "/files/list" && req.method === "GET") {
    if (!tokensEqual(tokenFromUrl(req.url) ?? "", deps.token)) {
      sendJson(res, 401, { error: "认证令牌无效，请重新启动应用。" });
      return true;
    }
    const root = deps.workspaceRoot(url.searchParams.get("workspaceId") ?? "");
    if (root === "") {
      sendJson(res, 400, { error: "未找到指定工作区，请在左侧选择工作区。" });
      return true;
    }
    try {
      sendJson(res, 200, listDirectory(root, url.searchParams.get("path") ?? ""));
    } catch (error) {
      sendJson(res, 400, { error: messageOf(error) });
    }
    return true;
  }

  if (url.pathname === "/files/read" && req.method === "GET") {
    if (!tokensEqual(tokenFromUrl(req.url) ?? "", deps.token)) {
      sendJson(res, 401, { error: "认证令牌无效，请重新启动应用。" });
      return true;
    }
    const root = deps.workspaceRoot(url.searchParams.get("workspaceId") ?? "");
    if (root === "") {
      sendJson(res, 400, { error: "未选择工作区，请在左侧选择工作区。" });
      return true;
    }
    try {
      sendJson(res, 200, readPreview(root, url.searchParams.get("path") ?? ""));
    } catch (error) {
      sendJson(res, 400, { error: messageOf(error) });
    }
    return true;
  }

  if (url.pathname === "/git/status" && req.method === "GET") {
    if (!tokensEqual(tokenFromUrl(req.url) ?? "", deps.token)) {
      sendJson(res, 401, { error: "认证令牌无效，请重新启动应用。" });
      return true;
    }
    const root = deps.workspaceRoot(url.searchParams.get("workspaceId") ?? "");
    if (root === "") {
      sendJson(res, 400, { error: "未选择工作区，请在左侧选择工作区。" });
      return true;
    }
    sendJson(res, 200, await gitSummary(root));
    return true;
  }

  }
  if (!url.pathname.startsWith("/oauth/google/")) return false;

  // 授权地址：渲染进程要跳转的目标，含 PKCE 挑战。Goolge 的客户端 ID 由渲染进程保存，这里只拼链接。
  if (url.pathname === "/oauth/google/start" && req.method === "GET") {
    const clientId = url.searchParams.get("clientId") ?? "";
    if (clientId === "") {
      sendJson(res, 400, { error: "缺少客户端 ID，请在设置中配置 Google OAuth 客户端 ID。" });
      return true;
    }
    const state = randomState();
    const redirectUri = `http://${LOOPBACK}:${url.searchParams.get("port") ?? ""}/oauth/google/callback`;
    const authUrl = buildAuthUrl({
      clientId,
      redirectUri,
      state,
      challenge: url.searchParams.get("challenge") ?? "",
    });
    sendJson(res, 200, { state, authUrl, redirectUri });
    return true;
  }

  // 回跳：浏览器带着 code 或 error 回到这里，写进待领取表，返回一张给人看的页。
  if (url.pathname === "/oauth/google/callback" && req.method === "GET") {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (state === "") {
      sendHtml(res, 400, callbackPage({ ok: false, reason: "回调里没有 state，无法确认这次登录是从本机发起的。" }));
      return true;
    }
    pendingAuth.put(state, {
      code: error === null ? code : null,
      error: error === null ? null : `Google 返回了错误：${error}`,
      at: Date.now(),
    });
    sendHtml(res, 200, callbackPage(error === null
      ? { ok: true, reason: "" }
      : { ok: false, reason: `Google 返回了错误：${error}，回到 SuperCoder 重试。` }));
    return true;
  }

  // 领结果：渲染进程轮询，拿到 code 或错误后这次登录就结束。
  if (url.pathname === "/oauth/google/pending" && req.method === "GET") {
    if (!tokensEqual(tokenFromUrl(req.url) ?? "", deps.token)) {
      sendJson(res, 401, { error: "认证令牌无效，请重新启动应用。" });
      return true;
    }
    const state = url.searchParams.get("state") ?? "";
    const found = pendingAuth.take(state);
    sendJson(res, 200, found ?? { code: null, error: null, at: 0 });
    return true;
  }

  // 换令牌：主进程去连 Google，避免浏览器 CORS 与凭据外露。
  if (url.pathname === "/oauth/google/token" && req.method === "POST") {
    if (!tokensEqual(tokenFromUrl(req.url) ?? "", deps.token)) {
      sendJson(res, 401, { error: "认证令牌无效，请重新启动应用。" });
      return true;
    }
    const body = await readJsonBody(req);
    const code = typeof body.code === "string" ? body.code : "";
    const verifier = typeof body.verifier === "string" ? body.verifier : "";
    const clientId = typeof body.clientId === "string" ? body.clientId : "";
    const redirectUri = typeof body.redirectUri === "string" ? body.redirectUri : "";
    if (code === "" || verifier === "" || clientId === "" || redirectUri === "") {
      sendJson(res, 400, { error: "OAuth 换取令牌参数缺失，请重新登录。" });
      return true;
    }
    try {
      const account = await exchangeCode({ code, verifier, clientId, redirectUri });
      sendJson(res, 200, account);
    } catch (error) {
      deps.logger.warn({ error: messageOf(error) }, "Google 登录失败");
      sendJson(res, 502, { error: messageOf(error) });
    }
    return true;
  }

  sendJson(res, 404, { error: "登录接口不存在或未启用。" });
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

/** 读一小段 JSON 请求体；超过 16KB 直接判失败，登录请求不会有这么大。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Buffer);
    size += buf.length;
    if (size > 16 * 1024) throw new Error("请求体超出大小限制。");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error("请求体不是合法 JSON。");
  }
}
