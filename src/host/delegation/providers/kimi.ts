/**
 * Kimi Code 本地服务接入。
 *
 * Kimi Code 桌面版在 `~/.kimi-code/server/instances/*.json` 里公布自己的端口，
 * 令牌在 `~/.kimi-code/server.token`。带 Bearer 打 `/api/v1/*` 就是完整的 REST API：
 * 建会话 → 设模型 → 投递 prompt → 轮询 turn 结果 → 读回消息。
 *
 * 确认过的约束：
 * - 建会话时传的 `agent_config.model` 会被忽略，模型必须随后走 `/profile` 设置。
 * - 没有流式接口：只能轮询 `last_turn_reason`，因此 `streaming: false`。
 * - 只读用 `plan_mode`，这是 Kimi 自己的计划模式，不是我们口头约定。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  DelegationEvent,
  DelegationRequest,
  DelegationResult,
} from "../../../shared/domain/delegation.js";
import type {
  DelegationHandle,
  DelegationProvider,
  ProviderCapabilities,
  ProviderInstallation,
  ProviderModel,
  ProviderPage,
  ProviderSessionSummary,
} from "../../../shared/domain/provider.js";
import { findInstalledExe, launchDetached } from "../../boot/exec.js";
import { buildDelegationPrompt } from "../prompt.js";
import { diagnostic } from "./codex-appserver.js";

interface Deps {
  readonly homeDir?: string;
  readonly fetchImpl?: typeof fetch;
  /** 测试注入：直接给端点与令牌，不读盘。 */
  readonly endpoint?: () => Promise<{ url: string; token: string } | null>;
  readonly pollMs?: number;
  readonly turnTimeoutMs?: number;
  /** 测试注入：找 Kimi Code 桌面版的可执行文件；生产走注册表。 */
  readonly findExe?: () => Promise<string | null>;
  /** 测试注入：拉起桌面版；生产用 launchDetached。 */
  readonly launch?: (exe: string) => void;
  readonly startupTimeoutMs?: number;
}

interface Endpoint {
  readonly url: string;
  readonly token: string;
}

const CAPABILITIES: ProviderCapabilities = {
  readOnly: true,
  resume: true,
  effort: false,
  streaming: false,
  receiptStates: ["queued", "submitted", "returned"],
  fragility: "documented",
};

const DEFAULT_POLL_MS = 1000;
const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;

/** 从卸载信息里找 Kimi Code 桌面版的安装位置（安装目录可自选，不写死）。 */
export async function findKimiExe(homeDir = homedir()): Promise<string | null> {
  const registered = findInstalledExe("Kimi Code", "Kimi Code.exe");
  if (registered !== null) return registered;
  const fallback = join(homeDir, "AppData", "Local", "Programs", "Kimi Code", "Kimi Code.exe");
  return existsSync(fallback) ? fallback : null;
}

/** Kimi 没在运行时读它自己的配置拿模型清单：不为了列模型去拉起桌面版。 */
export function kimiConfigModels(homeDir = homedir()): ProviderModel[] {
  let text: string;
  try {
    text = readFileSync(join(homeDir, ".kimi-code", "config.toml"), "utf8");
  } catch {
    return [];
  }
  const models: ProviderModel[] = [];
  let current: { id: string; label?: string; provider?: string } | null = null;
  const flush = (): void => {
    if (current === null) return;
    models.push({ id: current.id, label: current.label ?? current.id, ...(current.provider === undefined ? {} : { provider: current.provider }) });
  };
  for (const line of text.split(/\r?\n/)) {
    const section = /^\[models\."([^"]+)"\]\s*$/.exec(line);
    if (section !== null) { flush(); current = { id: section[1]! }; continue; }
    if (line.startsWith("[")) { flush(); current = null; continue; }
    if (current === null) continue;
    const pair = /^(display_name|provider)\s*=\s*"([^"]*)"/.exec(line);
    if (pair?.[1] === "display_name") current.label = pair[2]!;
    if (pair?.[1] === "provider") current.provider = providerName(pair[2]!);
  }
  flush();
  return models;
}

/** `managed:kimi-code` 这类内部名换成人看的供应商名。 */
function providerName(raw: string): string {
  const name = raw.replace(/^managed:/, "");
  return name === "kimi-code" ? "Kimi" : name;
}

/** 端点与令牌都来自 Kimi 自己的运行期文件；令牌不落我们任何地方。 */
export function kimiEndpoint(homeDir = homedir()): Endpoint | null {
  const root = join(homeDir, ".kimi-code");
  const tokenFile = join(root, "server.token");
  const instancesDir = join(root, "server", "instances");
  if (!existsSync(tokenFile) || !existsSync(instancesDir)) return null;
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    return null;
  }
  if (token === "") return null;
  let names: string[];
  try {
    names = readdirSync(instancesDir);
  } catch {
    return null;
  }
  // 多个实例时取心跳最新的那个。
  const instances = names
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(instancesDir, name), "utf8"));
        if (typeof parsed !== "object" || parsed === null) return [];
        const record = parsed as Record<string, unknown>;
        const port = record["port"];
        const host = record["host"];
        const heartbeat = record["heartbeat_at"];
        if (typeof port !== "number" || typeof host !== "string") return [];
        return [{ host, port, heartbeat: typeof heartbeat === "number" ? heartbeat : 0 }];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.heartbeat - left.heartbeat);
  const first = instances[0];
  if (first === undefined) return null;
  if (first.host !== "127.0.0.1" && first.host !== "localhost") return null;
  return { url: `http://127.0.0.1:${first.port}`, token };
}

export class KimiCodeProvider implements DelegationProvider {
  readonly id = "kimi-code";
  readonly capabilities = CAPABILITIES;

  constructor(private readonly deps: Deps = {}) {}

  private get fetcher(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  private async endpoint(): Promise<Endpoint | null> {
    const found = this.deps.endpoint !== undefined
      ? await this.deps.endpoint()
      : kimiEndpoint(this.deps.homeDir ?? homedir());
    if (found === null) return null;
    // 只连本机：令牌是本地服务的，不该被发到别处。
    let url: URL;
    try {
      url = new URL(found.url);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")) return null;
    return found;
  }

  private async call<T>(
    endpoint: Endpoint,
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.fetcher(new URL(path, endpoint.url), {
      ...init,
      signal: signal ?? AbortSignal.timeout(30_000),
      redirect: "error",
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Kimi 服务返回了非 JSON（HTTP ${response.status}）`);
    }
    const envelope = asRecord(body);
    if (envelope["code"] !== 0) {
      throw new Error(typeof envelope["msg"] === "string" ? envelope["msg"] : `Kimi 服务错误 ${response.status}`);
    }
    return envelope["data"] as T;
  }

  /** 服务在跑并且健康时返回端点；端口记录是 Kimi 留下的，退出后不清理，所以要验活。 */
  private async liveEndpoint(): Promise<Endpoint | null> {
    const endpoint = await this.endpoint();
    if (endpoint === null) return null;
    try {
      const health = await this.call<Record<string, unknown>>(endpoint, "/api/v1/healthz", {}, AbortSignal.timeout(3000));
      return health["ok"] === true ? endpoint : null;
    } catch {
      return null;
    }
  }

  private findExe(): Promise<string | null> {
    return this.deps.findExe?.() ?? findKimiExe(this.deps.homeDir ?? homedir());
  }

  /**
   * 任务分派前确保服务可用：没在跑就拉起桌面版，等它的本地服务就绪。
   * 与其它 Agent 一致——用户不需要先手动打开它。
   */
  private async ensureEndpoint(signal: AbortSignal): Promise<Endpoint | null> {
    const live = await this.liveEndpoint();
    if (live !== null) return live;
    const exe = await this.findExe();
    if (exe === null) return null;
    (this.deps.launch ?? ((path: string) => launchDetached(path)))(exe);
    const deadline = Date.now() + (this.deps.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    while (Date.now() < deadline && !signal.aborted) {
      await sleep(500, signal);
      const ready = await this.liveEndpoint();
      if (ready !== null) return ready;
    }
    return null;
  }

  async detect(): Promise<ProviderInstallation> {
    const live = await this.liveEndpoint();
    if (live !== null) return { installed: true, binaryPath: live.url };
    // 没在跑但装了：任务分派时会自动拉起，所以同样算可用。
    const exe = await this.findExe();
    return exe === null ? { installed: false, reason: "没有找到 Kimi Code 桌面版" } : { installed: true, binaryPath: exe };
  }

  async listModels(_workspace: string): Promise<ProviderModel[]> {
    const endpoint = await this.liveEndpoint();
    if (endpoint === null) return kimiConfigModels(this.deps.homeDir ?? homedir());
    const data = await this.call<{ items?: unknown[] }>(endpoint, "/api/v1/models");
    return (data.items ?? []).flatMap((item) => {
      const record = asRecord(item);
      const id = record["model"];
      if (typeof id !== "string") return [];
      const provider = typeof record["provider"] === "string" ? providerName(record["provider"]) : undefined;
      return [{ id, label: typeof record["display_name"] === "string" ? record["display_name"] : id, ...(provider === undefined ? {} : { provider }) }];
    });
  }

  async listSessions(_workspace: string, page: ProviderPage): Promise<ProviderSessionSummary[]> {
    const endpoint = await this.liveEndpoint();
    if (endpoint === null) return [];
    const data = await this.call<{ items?: unknown[] }>(
      endpoint,
      `/api/v1/sessions?page_size=${String(Math.min(100, page.offset + page.limit))}`,
    );
    return (data.items ?? [])
      .map((item) => {
        const record = asRecord(item);
        const id = record["id"];
        if (typeof id !== "string") return null;
        return {
          sessionId: id,
          title: typeof record["title"] === "string" && record["title"] !== "" ? record["title"] : "(无标题)",
          updatedAt: typeof record["updated_at"] === "string" ? record["updated_at"] : new Date(0).toISOString(),
        };
      })
      .filter((item): item is ProviderSessionSummary => item !== null)
      .slice(page.offset, page.offset + page.limit);
  }

  async readSession(sessionId: string, page: ProviderPage): Promise<DelegationEvent[]> {
    const endpoint = await this.liveEndpoint();
    if (endpoint === null) return [];
    const data = await this.call<{ items?: unknown[] }>(
      endpoint,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?page_size=100`,
    );
    const events: DelegationEvent[] = [];
    // 服务端按新到旧返回；历史要按时间顺序给人看。
    const ordered = (data.items ?? [])
      .map(asRecord)
      .sort((left, right) => String(left["created_at"] ?? "").localeCompare(String(right["created_at"] ?? "")));
    for (const record of ordered) {
      if (record["role"] !== "assistant") continue;
      const text = textOf(record["content"]);
      if (text !== null) events.push({ type: "output", text });
    }
    return events.slice(page.offset, page.offset + page.limit);
  }

  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const startedAt = Date.now();
    if (request.modelConfig) {
      return {
        status: "failed",
        diagnostic: diagnostic("handshake", "protocol", "Kimi Code 不接受注入的 API 档案，请用它在应用内的登录态"),
        durationMs: 0,
      };
    }
    if (request.signal.aborted) return { status: "aborted", durationMs: 0 };

    const endpoint = await this.ensureEndpoint(request.signal);
    if (request.signal.aborted) return { status: "aborted", durationMs: Date.now() - startedAt };
    if (endpoint === null) {
      return {
        status: "failed",
        diagnostic: diagnostic("handshake", "transport", "Kimi Code 没能启动或本地服务未就绪"),
        durationMs: Date.now() - startedAt,
      };
    }

    const emitDelivery = (state: string): void =>
      request.onEvent({ type: "trace", summary: `delivery:${state}` });

    try {
      request.onEvent({ type: "phase", phase: "spawn" });
      const sessionId = request.resumeSessionId ?? (await this.createSession(endpoint, request));
      const agentConfig: Record<string, unknown> = {};
      if (request.model) agentConfig["model"] = request.model;
      // plan_mode 是 Kimi 自己的只读模式：能读能查，不改文件。
      if (request.mode === "read-only") agentConfig["plan_mode"] = true;
      if (Object.keys(agentConfig).length > 0) {
        await this.call(endpoint, `/api/v1/sessions/${encodeURIComponent(sessionId)}/profile`, {
          method: "POST",
          body: JSON.stringify({ agent_config: agentConfig }),
        }, request.signal);
      }

      emitDelivery("queued");
      const submitted = await this.call<Record<string, unknown>>(
        endpoint,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`,
        {
          method: "POST",
          body: JSON.stringify({ content: [{ type: "text", text: buildDelegationPrompt(request) }] }),
        },
        request.signal,
      );
      emitDelivery("submitted");
      request.onEvent({ type: "session", sessionId });

      // 中断只靠 AbortSignal 传进来；投递之后要主动让 Kimi 停下这一轮，否则它会在后台接着跑。
      const promptId = typeof submitted["prompt_id"] === "string" ? submitted["prompt_id"] : null;
      // 服务端时钟下的投递时刻：之后判"这一轮"只认它之后的状态与回复，
      // 续话时上一轮残留的 completed 不能被当成本轮结论。
      const since = typeof submitted["created_at"] === "string" ? submitted["created_at"] : new Date(Date.now() - 1000).toISOString();
      const abortRemote = (): void => {
        if (promptId === null) return;
        void this.call(
          endpoint,
          `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
          { method: "POST", body: "{}" },
        ).catch(() => {
          /* 回合可能已经自己结束 */
        });
      };
      request.signal.addEventListener("abort", abortRemote, { once: true });

      let outcome: Awaited<ReturnType<KimiCodeProvider["waitForTurn"]>>;
      try {
        outcome = await this.waitForTurn(endpoint, sessionId, since, request.signal, (text) => request.onEvent({ type: "output", text }));
      } finally {
        request.signal.removeEventListener("abort", abortRemote);
      }
      request.onEvent({ type: "phase", phase: "collect" });
      emitDelivery("returned");

      if (outcome.status === "aborted") return { status: "aborted", durationMs: Date.now() - startedAt };
      if (outcome.status === "unknown") {
        return { status: "unknown", observed: outcome.observed, since: new Date().toISOString() };
      }
      if (outcome.status === "failed") {
        return {
          status: "failed",
          diagnostic: diagnostic("turn", outcome.category, outcome.detail),
          durationMs: Date.now() - startedAt,
        };
      }
      const answer = await this.readAnswer(endpoint, sessionId, since);
      if (answer === null) {
        return {
          status: "failed",
          diagnostic: diagnostic("collect", "invalid-result", "Kimi Code 的回合结束了，但没有读到回复正文"),
          durationMs: Date.now() - startedAt,
        };
      }
      return { status: "ok", answer, sessionId, durationMs: Date.now() - startedAt };
    } catch (error) {
      const message = messageOf(error);
      if (request.signal.aborted) return { status: "aborted", durationMs: Date.now() - startedAt };
      return {
        status: "failed",
        diagnostic: diagnostic("turn", "transport", message),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  private async createSession(endpoint: Endpoint, request: DelegationRequest): Promise<string> {
    const data = await this.call<Record<string, unknown>>(
      endpoint,
      "/api/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          title: "SuperCoder",
          metadata: { cwd: request.workspace },
          agent_config: { permission_mode: request.mode === "read-only" ? "manual" : "yolo" },
        }),
      },
      request.signal,
    );
    const id = data["id"];
    if (typeof id !== "string") throw new Error("Kimi 建会话的响应缺少 id");
    return id;
  }

  /**
   * 轮询会话直到本轮落定。Kimi 没有流式接口。
   *
   * "落定"要同时满足：会话不忙，且确有本轮的迹象（轮询中见过它忙，或会话更新时间晚于投递）。
   * 只看 `last_turn_reason` 不够——续话时它还停留在上一轮的 completed。
   */
  private async waitForTurn(
    endpoint: Endpoint,
    sessionId: string,
    since: string,
    signal: AbortSignal,
    onText?: (text: string) => void,
  ): Promise<
    | { status: "ok" }
    | { status: "aborted" }
    | { status: "unknown"; observed: string }
    | { status: "failed"; category: "limit" | "access-policy" | "service" | "unknown"; detail: string }
  > {
    const timeoutMs = this.deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const pollMs = this.deps.pollMs ?? DEFAULT_POLL_MS;
    let sawActive = false;
    // Kimi 没有流式接口，但每完成一步就落一条回复消息：轮询时顺带把本轮新出现的回复转发出去。
    const relayed = new Set<string>();
    const relay = async (): Promise<void> => {
      if (onText === undefined) return;
      const page = await this.call<{ items?: unknown[] }>(
        endpoint,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?role=assistant&page_size=20`,
        {},
        signal,
      ).catch(() => ({ items: [] as unknown[] }));
      const fresh = (page.items ?? [])
        .map(asRecord)
        .filter((item) => typeof item["created_at"] === "string" && item["created_at"] >= since)
        .sort((left, right) => String(left["created_at"]).localeCompare(String(right["created_at"])));
      for (const item of fresh) {
        const key = typeof item["id"] === "string" ? item["id"] : String(item["created_at"]);
        if (relayed.has(key)) continue;
        const text = textOf(item["content"]);
        if (text === null) continue;
        relayed.add(key);
        onText(relayed.size > 1 ? `\n\n${text}` : text);
      }
    };
    while (Date.now() < deadline) {
      if (signal.aborted) return { status: "aborted" };
      await relay();
      const data = await this.call<Record<string, unknown>>(
        endpoint,
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
        {},
        signal,
      ).catch(() => null);
      if (data !== null) {
        const active = data["busy"] === true || data["main_turn_active"] === true;
        if (active) sawActive = true;
        const updatedAt = typeof data["updated_at"] === "string" ? data["updated_at"] : "";
        const touched = updatedAt !== "" && updatedAt >= since;
        if (!active && (sawActive || touched)) {
          const reason = data["last_turn_reason"];
          if (reason === "completed") {
            await relay();
            return { status: "ok" };
          }
          if (reason === "aborted" || reason === "cancelled") return { status: "aborted" };
          if (reason === "failed") {
            const warnings = await this.call<{ warnings?: unknown[] }>(
              endpoint,
              `/api/v1/sessions/${encodeURIComponent(sessionId)}/warnings`,
            ).catch(() => ({ warnings: [] }));
            const first = (warnings.warnings ?? [])[0];
            const detail = typeof first === "string" ? first : first === undefined ? "Kimi 报告这一轮失败" : JSON.stringify(first);
            return { status: "failed", category: "unknown", detail: detail.slice(0, 200) };
          }
        }
      }
      await sleep(pollMs, signal);
    }
    if (signal.aborted) return { status: "aborted" };
    // 已投递却等不到结论：不能当失败，工作区可能已经动过。
    return {
      status: "unknown",
      observed: `任务已投递，但 ${String(Math.round(timeoutMs / 1000))} 秒内没有等到 Kimi 的结论；无法确认工作区副作用`,
    };
  }

  /** 取本轮的最终回复：只认投递之后的 assistant 消息，按时间取最新一条（服务端顺序不作依据）。 */
  private async readAnswer(endpoint: Endpoint, sessionId: string, since: string): Promise<string | null> {
    const data = await this.call<{ items?: unknown[] }>(
      endpoint,
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages?role=assistant&page_size=100`,
    ).catch(() => ({ items: [] }));
    const candidates = (data.items ?? [])
      .map(asRecord)
      .filter((record) => typeof record["created_at"] !== "string" || record["created_at"] >= since)
      .sort((left, right) => String(right["created_at"] ?? "").localeCompare(String(left["created_at"] ?? "")));
    for (const record of candidates) {
      // 只取 text：thinking 是过程话，不是答案。
      const text = textOf(record["content"]);
      if (text !== null) return text;
    }
    return null;
  }

  async cancel(_handle: DelegationHandle): Promise<void> {
    // 中断走 AbortSignal：delegate 里已经挂了远端 abort。
  }
}

function textOf(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (record["type"] === "text" && typeof record["text"] === "string" && record["text"] !== "") {
      parts.push(record["text"]);
    }
  }
  return parts.length === 0 ? null : parts.join("\n");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
