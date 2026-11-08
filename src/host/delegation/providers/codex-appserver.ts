/**
 * Codex app-server 接入。
 *
 * 走 JSON-RPC over stdio：initialize → initialized → thread/start（或 thread/resume）
 * → 发一轮 turn → 读通知直到 `turn/completed` → 按  选答案。
 *
 * 协议是官方声明的，因此 `fragility: "official"`。
 */

import type {
  DelegationEvent,
  DelegationPhase,
  DelegationRequest,
  DelegationResult,
  SafeDiagnostic,
  AgentModelConfig,
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
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runProcess, sanitizedEnv, spawnChild, whichBinary } from "../../boot/exec.js";
import { messageOf } from "../../boot/failure.js";
import { selectAnswer, type AnswerCandidate } from "../answer.js";
import { buildDelegationPrompt } from "../prompt.js";
import {
  createStdioTransport,
  type JsonRpcTransport,
  type RpcNotification,
} from "../transport.js";

export const CODEX_APP_SERVER_ID = "codex";

export const CODEX_APP_SERVER_CAPABILITIES: ProviderCapabilities = {
  // 只读任务走 Codex 自己的 read-only 沙箱，是对方强制的。
  readOnly: true,
  resume: true,
  effort: true,
  streaming: true,
  receiptStates: ["queued", "submitted", "received", "returned"],
  fragility: "official",
};

export interface CodexAppServerDeps {
  /** 测试注入录制的传输层；生产用它自己的 `spawnCodexTransport`。 */
  readonly createTransport?: (workspace: string) => JsonRpcTransport;
  readonly detect?: () => Promise<ProviderInstallation>;
  readonly turnTimeoutMs?: number;
  readonly allowPermissions?: () => boolean;
}

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;

export class CodexAppServerProvider implements DelegationProvider {
  readonly id = CODEX_APP_SERVER_ID;
  readonly capabilities = CODEX_APP_SERVER_CAPABILITIES;

  constructor(private readonly deps: CodexAppServerDeps = {}) {}

  async detect(): Promise<ProviderInstallation> {
    if (this.deps.detect !== undefined) return this.deps.detect();
    return detectCodex();
  }

  async listModels(workspace: string): Promise<ProviderModel[]> {
    const transport = this.deps.createTransport?.(workspace) ?? spawnCodexTransport(workspace || process.cwd());
    try {
      await initialize(transport);
      const result = asRecord(await transport.request("model/list", { limit: 100, includeHidden: false }));
      if (!Array.isArray(result["data"])) throw new Error("Codex 模型清单格式不符");
      return result["data"].flatMap((value) => { const item = asRecord(value); const id = item["model"] ?? item["id"]; return typeof id === "string" ? [{ id, label: typeof item["displayName"] === "string" ? item["displayName"] : id, current: item["isDefault"] === true, provider: "OpenAI" }] : []; });
    } finally { transport.close(); }
  }

  async listSessions(workspace: string, page: ProviderPage): Promise<ProviderSessionSummary[]> {
    const transport = this.deps.createTransport?.(workspace) ?? spawnCodexTransport(workspace || process.cwd());
    try {
      await initialize(transport);
      const threads: Array<{ id?: string; name?: string | null; preview?: string; updatedAt?: number }> = [];
      let cursor: string | null = null;
      do {
        const result: { data?: typeof threads; nextCursor?: string | null } = await transport.request("thread/list", {
          ...(workspace ? { cwd: workspace } : {}), cursor, limit: Math.min(100, page.offset + page.limit),
        }) as { data?: typeof threads; nextCursor?: string | null };
        threads.push(...(result.data ?? []));
        cursor = result.nextCursor ?? null;
      } while (cursor !== null && threads.length < page.offset + page.limit);
      return threads.slice(page.offset, page.offset + page.limit).map((thread) => ({
        sessionId: thread.id ?? "",
        title: thread.name || thread.preview || "(无标题)",
        updatedAt: new Date((thread.updatedAt ?? 0) * 1000).toISOString(),
      }));
    } finally {
      transport.close();
    }
  }

  async readSession(sessionId: string, page: ProviderPage): Promise<DelegationEvent[]> {
    const transport = this.deps.createTransport?.("") ?? spawnCodexTransport(process.cwd());
    try {
      await initialize(transport);
      const result = (await transport.request("thread/read", {
        threadId: sessionId,
        includeTurns: true,
      })) as { thread?: { turns?: Array<{ items?: Array<{ type?: string; text?: string; content?: Array<{ text?: string }> }> }> } };
      const items = (result.thread?.turns ?? []).flatMap((turn) => turn.items ?? []);
      return items.flatMap((item) => {
        const text = item.text ?? item.content?.map((part) => part.text ?? "").join("") ?? "";
        return text ? [{ type: "output" as const, text: `${item.type ?? "agent"}: ${text}` }] : [];
      }).slice(page.offset, page.offset + page.limit);
    } finally {
      transport.close();
    }
  }

  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const startedAt = Date.now();
    const transport =
      this.deps.createTransport?.(request.workspace) ?? spawnCodexTransport(request.workspace, request.modelConfig, this.deps.allowPermissions);
    const candidates: AnswerCandidate[] = [];
    let phase: DelegationPhase = "handshake";
    let turnSent = false;
    let sessionId: string | undefined;
    let toolCallSinceCandidate = false;
    const streamedItems = new Set<string>();

    const emit = (event: DelegationEvent): void => request.onEvent(event);
    const mark = (state: "queued" | "submitted" | "received" | "returned"): void =>
      emit({ type: "trace", summary: `delivery:${state}` });
    const onAbort = (): void => transport.close();
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (request.signal.aborted) return { status: "aborted", durationMs: 0 };
      emit({ type: "phase", phase: "handshake" });
      await initialize(transport);
      mark("queued");

      let threadId: string;
      if (request.resumeSessionId !== undefined && request.resumeSessionId !== "") {
        const resumed = (await transport.request("thread/resume", {
          threadId: request.resumeSessionId,
          cwd: request.workspace,
          sandbox: request.mode === "read-only" ? "read-only" : "workspace-write",
        })) as { thread?: { id?: string }; threadId?: string };
        threadId = resumed.thread?.id ?? resumed.threadId ?? request.resumeSessionId;
      } else {
        const thread = (await transport.request("thread/start", {
          cwd: request.workspace,
          // Persist read-only sessions too, so the user's Codex client can discover them.
          ephemeral: false,
          sandbox: request.mode === "read-only" ? "read-only" : "workspace-write",
        })) as { thread?: { id?: string }; threadId?: string };
        const id = thread.thread?.id ?? thread.threadId;
        if (id === undefined) {
          return {
            status: "failed",
            diagnostic: diagnostic("handshake", "protocol", "thread/start 没有返回 threadId"),
            durationMs: Date.now() - startedAt,
          };
        }
        threadId = id;
      }
      sessionId = threadId;
      emit({ type: "session", sessionId: threadId });

      const completion = this.waitForCompletion(transport, request, (notification) => {
        if (notification.method === "supercoder/permission") {
          emit({ type: "trace", summary: asRecord(notification.params)["allowed"] === true ? "permission:allowed" : "permission:denied" });
          return { kind: "progress" };
        }
        if (notification.method === "item/agentMessage/delta") {
          const payload = asRecord(notification.params);
          if (typeof payload["itemId"] === "string" && typeof payload["delta"] === "string") {
            streamedItems.add(payload["itemId"]);
            emit({ type: "output", text: payload["delta"] });
            mark("received");
          }
          return { kind: "progress" };
        }
        if (notification.method === "turn/completed") {
          const turn = asRecord(asRecord(notification.params)["turn"]);
          if (turn["status"] === "failed" || turn["status"] === "interrupted") {
            const error = asRecord(turn["error"]);
            return { kind: "failed", reason: typeof error["message"] === "string" ? error["message"] : `回合状态：${String(turn["status"])}` };
          }
          return { kind: "completed" };
        }
        if (notification.method === "error" || notification.method === "turn/error") {
          const payload = asRecord(notification.params);
          if (payload["willRetry"] === true) return { kind: "progress" };
          const error = asRecord(payload["error"]);
          return {
            kind: "failed",
            reason: typeof payload["message"] === "string" ? payload["message"] : typeof error["message"] === "string" ? error["message"] : "对端报错",
          };
        }
        if (notification.method !== "turn/event" && notification.method !== "item/completed") {
          return { kind: "progress" };
        }
        const payload = asRecord(notification.params);
        const item = notification.method === "item/completed" ? asRecord(payload["item"]) : payload;
        const kind = typeof item["type"] === "string" ? item["type"] : typeof item["kind"] === "string" ? item["kind"] : "";
        if (kind === "tool_call" || kind === "tool_result" || kind === "commandExecution" || kind === "fileChange" || kind === "mcpToolCall") {
          // 工具调用发生在已有候选之后：那些候选只能算中间答案。
          for (let at = 0; at < candidates.length; at += 1) {
            const previous = candidates[at];
            if (previous !== undefined) candidates[at] = { ...previous, toolCallAfter: true };
          }
          toolCallSinceCandidate = false;
          return { kind: "progress" };
        }
        if (notification.method === "item/completed" && kind !== "agentMessage") return { kind: "progress" };
        const text = typeof item["text"] === "string" ? item["text"] : undefined;
        if (text === undefined || text === "") return { kind: "progress" };
        candidates.push({
          phase: typeof item["phase"] === "string" ? item["phase"] : null,
          text,
          ...(toolCallSinceCandidate ? { toolCallAfter: true } : {}),
        });
        toolCallSinceCandidate = false;
        phase = "turn";
        if (typeof item["id"] !== "string" || !streamedItems.has(item["id"])) emit({ type: "output", text });
        mark("received");
        return { kind: "progress" };
      });

      await transport.request("turn/start", {
        threadId,
        input: [{ type: "text", text: buildDelegationPrompt(request), text_elements: [] }],
        ...(request.effort === undefined ? {} : { effort: request.effort }),
        ...(request.modelConfig ? { model: request.modelConfig.model } : request.model === undefined ? {} : { model: request.model }),
      });
      // turn/start 真正被受理之后才算"已提交"：请求本身被拒（协议不认识、模型名无效）
      // 时什么都没跑，不能报 unknown，否则上层失去换下一个 provider 的机会。
      turnSent = true;
      mark("submitted");
      emit({ type: "phase", phase: "turn" });

      const outcome = await completion;
      if (outcome.kind === "aborted") {
        return turnSent ? { status: "unknown", observed: "已中断 Codex 进程，无法确认工作区副作用", since: new Date().toISOString() } : { status: "aborted", durationMs: Date.now() - startedAt };
      }
      if (outcome.kind === "exited") {
        // turn 已发出、进程却先退出：可能已经动过手，只能记 unknown（C7）。
        return turnSent
          ? {
              status: "unknown",
              observed: `外部进程在回合结束前退出（code=${String(outcome.code)}）`,
              since: new Date().toISOString(),
            }
          : {
              status: "failed",
              diagnostic: diagnostic("spawn", "process", `外部进程退出（code=${String(outcome.code)}）`),
              durationMs: Date.now() - startedAt,
            };
      }
      if (outcome.kind === "failed") {
        if (outcome.reason.startsWith("回合超时")) return { status: "unknown", observed: outcome.reason, since: new Date().toISOString() };
        return {
          status: "failed",
          diagnostic: diagnostic("turn", classify(outcome.reason), outcome.reason),
          durationMs: Date.now() - startedAt,
        };
      }

      mark("returned");
      emit({ type: "phase", phase: "collect" });
      const selection = selectAnswer(candidates);
      if (!selection.ok) {
        return {
          status: "failed",
          diagnostic: diagnostic("collect", "invalid-result", selection.detail),
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        status: "ok",
        answer: selection.answer,
        durationMs: Date.now() - startedAt,
        ...(sessionId === undefined ? {} : { sessionId }),
      };
    } catch (error) {
      const message = messageOf(error);
      if (request.signal.aborted) return turnSent ? { status: "unknown", observed: "已中断 Codex 进程，无法确认工作区副作用", since: new Date().toISOString() } : { status: "aborted", durationMs: Date.now() - startedAt };
      const category = classify(message);
      if (turnSent) {
        return {
          status: "unknown",
          observed: message,
          since: new Date().toISOString(),
        };
      }
      return {
        status: "failed",
        diagnostic: diagnostic(phase === "handshake" ? "handshake" : "turn", category, message),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      transport.close();
    }
  }

  async cancel(_handle: DelegationHandle): Promise<void> {
    // 资源随 delegate 的 finally 关闭；app-server 侧没有额外取消调用。
  }

  private waitForCompletion(
    transport: JsonRpcTransport,
    request: DelegationRequest,
    inspect: (notification: RpcNotification) => CompletionOutcome,
  ): Promise<CompletionOutcome> {
    const timeoutMs = this.deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    return new Promise<CompletionOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: CompletionOutcome): void => {
        if (settled) return;
        settled = true;
        offNotification();
        offExit();
        request.signal.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        resolve(outcome);
      };
      const onAbort = (): void => finish({ kind: "aborted" });
      const timer = setTimeout(
        () => finish({ kind: "failed", reason: `回合超时（${Math.round(timeoutMs / 1000)} 秒）` }),
        timeoutMs,
      );
      timer.unref();
      const offNotification = transport.onNotification((notification) => {
        const verdict = inspect(notification);
        if (verdict.kind !== "progress") finish(verdict);
      });
      const offExit = transport.onExit((info) => finish({ kind: "exited", code: info.code }));
      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) onAbort();
    });
  }
}

async function initialize(transport: JsonRpcTransport): Promise<void> {
  await transport.request("initialize", { clientInfo: { name: "supercoder", version: "0.1.0" } });
  transport.notify("initialized", {});
}

type CompletionOutcome =
  | { readonly kind: "progress" }
  | { readonly kind: "completed" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "exited"; readonly code: number | null }
  | { readonly kind: "aborted" };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function diagnostic(
  stage: SafeDiagnostic["stage"],
  category: SafeDiagnostic["category"],
  detail?: string,
): SafeDiagnostic {
  return {
    stage,
    category,
    ...(detail === undefined || detail === ""
      ? {}
      : { detail: detail.slice(0, 200) }),
  };
}

/** 把错误信息映射到  的分类。分类只为给人看，不用于自动重试。 */
export function classify(message: string): SafeDiagnostic["category"] {
  const text = message.toLowerCase();
  const table: ReadonlyArray<readonly [RegExp, SafeDiagnostic["category"]]> = [
    [/rate.?limit|too many requests|429|quota/, "limit"],
    [/403|forbidden|access.?policy|not allowed/, "access-policy"],
    [/401|unauthor|login|token/, "auth"],
    [/timeout|timed out|503|502|500|unavailable|overloaded/, "service"],
    [/econn|socket|network|transport|epipe|closed/, "transport"],
    [/json|protocol|unexpected response|parse/, "protocol"],
    [/exit|spawn|enoent|killed|signal/, "process"],
  ];
  for (const [pattern, category] of table) {
    if (pattern.test(text)) return category;
  }
  return "unknown";
}

export function spawnCodexTransport(workspace: string, modelConfig?: AgentModelConfig, allowPermissions?: () => boolean): JsonRpcTransport {
  const args = ["app-server"];
  if (modelConfig) args.push("-c", 'model_provider="supercoder"', "-c", 'web_search="disabled"', "-c", 'model_providers.supercoder.name="SuperCoder"', "-c", `model_providers.supercoder.base_url=${JSON.stringify(modelConfig.baseUrl)}`, "-c", 'model_providers.supercoder.env_key="SUPERCODER_AGENT_API_KEY"', "-c", 'model_providers.supercoder.wire_api="responses"', "-c", "model_providers.supercoder.requires_openai_auth=false", "-c", "model_providers.supercoder.supports_websockets=false");
  const child = spawnChild(codexBinary(), args, { cwd: workspace, ...(modelConfig ? { env: sanitizedEnv({ SUPERCODER_AGENT_API_KEY: modelConfig.apiKey }) } : {}) });
  return createStdioTransport(child, { allowPermissions: allowPermissions ?? (() => false) });
}

/** 最近一次探测到的 codex 可执行文件；探测之前退回 PATH 上的 `codex`。 */
let resolvedCodex: string | null = null;

export function codexBinary(): string {
  return resolvedCodex ?? "codex";
}

/**
 * 找 codex：先看 PATH（独立安装的 CLI），再看 Codex 桌面版（MSIX 包里自带 `app/resources/codex.exe`）。
 * 桌面版的安装目录带版本号、随更新变化，所以每次探测都通过 Get-AppxPackage 重新查，不写死路径。
 */
export async function detectCodex(): Promise<ProviderInstallation> {
  const onPath = await whichBinary("codex", process.cwd());
  if (onPath !== null) {
    resolvedCodex = onPath;
    return { installed: true, binaryPath: onPath };
  }
  if (process.platform === "win32") {
    const bundled = await findDesktopCodex();
    if (bundled !== null) {
      resolvedCodex = bundled;
      return { installed: true, binaryPath: bundled };
    }
  }
  resolvedCodex = null;
  return { installed: false, reason: "没有找到 Codex（PATH 里没有 codex，也没有安装 Codex 桌面版）" };
}

/**
 * 桌面端自 2026 年起改名为 ChatGPT，商店包里仍然是同一个 `codex.exe`。
 * 包名会随产品改名而变，所以按候选包名列，再退回到按名称模糊匹配——
 * 不能只认 `OpenAI.Codex`，否则新版桌面上会一律显示"未安装"。
 */
const CODEX_APPX_PACKAGES = ["OpenAI.Codex", "OpenAI.ChatGPT", "OpenAI.ChatGPT-Desktop"];

async function findDesktopCodex(): Promise<string | null> {
  for (const packageName of CODEX_APPX_PACKAGES) {
    const found = await appxInstallLocation(packageName, true);
    const exe = found === null ? null : join(found, "app", "resources", "codex.exe");
    if (exe !== null && existsSync(exe)) return exe;
  }
  // 兜底：名字变了也认得出。只取名字里同时含 OpenAI 或 ChatGPT 的包，不做全盘搜索。
  const fuzzy = await appxInstallLocation("ChatGPT", false);
  const exe = fuzzy === null ? null : join(fuzzy, "app", "resources", "codex.exe");
  return exe !== null && existsSync(exe) ? exe : null;
}

/** 查商店应用的安装目录。`exact` 为真时按包名精确匹配，否则按名称模糊匹配。 */
async function appxInstallLocation(name: string, exact: boolean): Promise<string | null> {
  const script = exact
    ? `(Get-AppxPackage -Name ${JSON.stringify(name)} | Select-Object -First 1).InstallLocation`
    : `Get-AppxPackage | Where-Object { $_.Name -like ${JSON.stringify(`*${name}*`)} } | Select-Object -First 1 -ExpandProperty InstallLocation`;
  const result = await runProcess("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: process.cwd(),
    timeoutMs: 15_000,
    consoleEncoding: true,
  });
  const root = result.code === 0 ? result.stdout.trim() : "";
  return root === "" ? null : root;
}
