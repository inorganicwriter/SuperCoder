/**
 * ACP 接入。
 *
 * ACP（Agent Client Protocol）是开放协议：`initialize` → `session/new` → `session/prompt`，
 * 过程中靠 `session/update` 通知推增量，`session/prompt` 的返回值带 `stopReason` 结算。
 *
 * 协议本身是官方的，因此 `fragility: "official"`；各家实现完备度不同，能力按最保守声明。
 * 这里不自己发明"回合结束"信号：以 `stopReason` 为准，通知只用来收集文本。
 */

import type {
  DelegationEvent,
  DelegationPhase,
  DelegationRequest,
  DelegationResult,
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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizedEnv, spawnChild, whichBinary } from "../../boot/exec.js";
import { messageOf } from "../../boot/failure.js";
import { selectAnswer, type AnswerCandidate } from "../answer.js";
import { buildDelegationPrompt } from "../prompt.js";
import { createStdioTransport, type JsonRpcTransport, type RpcNotification } from "../transport.js";
import { classify, diagnostic } from "./codex-appserver.js";

export const ACP_ID = "acp";

export const ACP_CAPABILITIES: ProviderCapabilities = {
  readOnly: false,
  resume: true,
  effort: false,
  streaming: true,
  receiptStates: ["queued", "submitted", "received", "returned"],
  fragility: "official",
};

export interface AcpDeps {
  readonly providerId?: string;
  readonly binary?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly capabilities?: ProviderCapabilities;
  readonly allowPermissions?: () => boolean;
  readonly createTransport?: (workspace: string) => JsonRpcTransport;
  readonly detect?: () => Promise<ProviderInstallation>;
  readonly promptTimeoutMs?: number;
  /** 收到 stopReason 之后再等一小会儿，让仍在路上的增量通知落袋。 */
  readonly drainMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class AcpProvider implements DelegationProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly binary: string;
  private readonly extraArgs: readonly string[];

  constructor(private readonly deps: AcpDeps = {}) {
    this.id = deps.providerId ?? ACP_ID;
    this.capabilities = deps.capabilities ?? ACP_CAPABILITIES;
    this.binary = deps.binary ?? "opencode";
    this.extraArgs = deps.args ?? ["acp"];
  }

  async detect(): Promise<ProviderInstallation> {
    if (this.deps.detect !== undefined) return this.deps.detect();
    const binaryPath = await whichBinary(this.binary, process.cwd());
    return binaryPath === null
      ? { installed: false, reason: `未在 PATH 中找到 ${this.binary}，请安装后重新探测。` }
      : { installed: true, binaryPath };
  }

  private transport(workspace: string, modelConfig?: AgentModelConfig): JsonRpcTransport {
    const extra: Record<string, string> = { ...this.deps.env };
    let args = this.extraArgs;
    let patchDir: string | undefined;
    if (modelConfig) {
      extra["SUPERCODER_AGENT_API_KEY"] = modelConfig.apiKey;
      if (this.id === "deepseek-harness" && !this.deps.createTransport) {
        patchDir = mkdtempSync(join(tmpdir(), "supercoder-dsh-"));
        const patchFile = join(patchDir, "profile.json");
        try {
          writeFileSync(patchFile, JSON.stringify([
            { id: "llm-pi-ai", config: { providers: { supercoder: { api: "openai-completions", baseURL: modelConfig.baseUrl, apiKeyEnv: "SUPERCODER_AGENT_API_KEY", models: [{ id: modelConfig.model }] } } } },
            { id: "acp", config: { provider: "supercoder", model: modelConfig.model } },
          ]), { mode: 0o600 });
        } catch (error) { rmSync(patchDir, { recursive: true, force: true }); throw error; }
        args = [...this.extraArgs.slice(0, -1), "--profile", "acp", "--patch", patchFile];
      } else if (this.id === "opencode") extra["OPENCODE_CONFIG_CONTENT"] = JSON.stringify({
        provider: { supercoder: { name: "SuperCoder", npm: "@ai-sdk/openai-compatible", options: { baseURL: modelConfig.baseUrl, apiKey: "{env:SUPERCODER_AGENT_API_KEY}" }, models: { [modelConfig.model]: { name: modelConfig.model, tool_call: true } } } },
      });
    }
    try {
      const transport = this.deps.createTransport?.(workspace) ?? createStdioTransport(spawnChild(this.binary, args, { cwd: workspace || process.cwd(), ...(modelConfig || this.deps.env ? { env: sanitizedEnv(extra) } : {}) }), { allowPermissions: this.deps.allowPermissions ?? (() => false) });
      if (!patchDir) return transport;
      const dir = patchDir;
      return { ...transport, close: () => { try { transport.close(); } finally { rmSync(dir, { recursive: true, force: true }); } } };
    } catch (error) { if (patchDir) rmSync(patchDir, { recursive: true, force: true }); throw error; }
  }

  private async initialize(transport: JsonRpcTransport): Promise<Record<string, unknown>> {
    const result = asRecord(await transport.request("initialize", {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "supercoder", version: "0.1.0" },
    }));
    if (result["protocolVersion"] !== undefined && result["protocolVersion"] !== 1) throw new Error("不支持的 ACP 协议版本");
    return asRecord(result["agentCapabilities"]);
  }

  async listModels(workspace: string): Promise<ProviderModel[]> {
    const transport = this.transport(workspace);
    try {
      await this.initialize(transport);
      const session = asRecord(await transport.request("session/new", { cwd: workspace, mcpServers: [] }));
      const options = Array.isArray(session["configOptions"]) ? session["configOptions"].map(asRecord) : [];
      const model = options.find((option) => option["category"] === "model" || option["id"] === "model");
      if (model) {
        const entries = Array.isArray(model["options"]) ? model["options"] : [];
        const flatten = (items: unknown[], group?: string): ProviderModel[] => items.flatMap((item) => {
          const value = asRecord(item);
          if (Array.isArray(value["options"])) return flatten(value["options"], typeof value["name"] === "string" ? value["name"] : group);
          if (typeof value["value"] !== "string") return [];
          const name = typeof value["name"] === "string" ? value["name"] : value["value"];
          // 名字里自带"供应商/模型"（OpenCode 就是这样）时拆开：分组用前缀，选项只显示模型名。
          const split = group === undefined ? splitProvider(name) : null;
          const provider = group ?? split?.provider ?? providerOf(value["value"]) ?? vendorOf(name);
          return [{ id: value["value"], label: split?.label ?? name, current: value["value"] === model["currentValue"], ...(provider === undefined ? {} : { provider }) }];
        });
        return flatten(entries);
      }
      const legacy = asRecord(session["models"]);
      if (!Array.isArray(legacy["availableModels"])) throw new Error("该 ACP Agent 未提供模型列表");
      return legacy["availableModels"].flatMap((entry) => {
        const m = asRecord(entry);
        if (typeof m["modelId"] !== "string") return [];
        const provider = providerOf(m["modelId"]) ?? vendorOf(typeof m["name"] === "string" ? m["name"] : m["modelId"]);
        return [{ id: m["modelId"], label: typeof m["name"] === "string" ? m["name"] : m["modelId"], current: m["modelId"] === legacy["currentModelId"], ...(provider === undefined ? {} : { provider }) }];
      });
    } finally { transport.close(); }
  }

  /**
   * 翻页取会话。`done` 可以在拿到目标之后提前停：验证一个 session_id 不该把执行者
   * 那边的全部历史都翻一遍。
   */
  private async sessions(transport: JsonRpcTransport, workspace: string, needed: number, done?: (sessions: readonly AcpSession[]) => boolean): Promise<AcpSession[]> {
    const sessions: AcpSession[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = asRecord(await transport.request("session/list", { ...(workspace ? { cwd: workspace } : {}), ...(cursor ? { cursor } : {}) }));
      if (!Array.isArray(result["sessions"])) throw new Error("session/list 返回格式无效");
      for (const entry of result["sessions"]) {
        const item = asRecord(entry);
        if (typeof item["sessionId"] === "string" && typeof item["cwd"] === "string") sessions.push({ sessionId: item["sessionId"], cwd: item["cwd"], title: typeof item["title"] === "string" ? item["title"] : "(无标题)", updatedAt: typeof item["updatedAt"] === "string" ? item["updatedAt"] : new Date(0).toISOString() });
      }
      cursor = typeof result["nextCursor"] === "string" && result["nextCursor"] ? result["nextCursor"] : undefined;
      if (cursor && seen.has(cursor)) throw new Error("session/list 返回了重复游标");
      if (cursor) seen.add(cursor);
    } while (cursor && sessions.length < needed && done?.(sessions) !== true);
    return sessions;
  }

  async listSessions(workspace: string, page: ProviderPage): Promise<ProviderSessionSummary[]> {
    const transport = this.transport(workspace);
    try {
      const capabilities = await this.initialize(transport);
      if (asRecord(capabilities["sessionCapabilities"])["list"] === undefined) return [];
      return (await this.sessions(transport, workspace, page.offset + page.limit)).slice(page.offset, page.offset + page.limit);
    } finally { transport.close(); }
  }

  async readSession(sessionId: string, page: ProviderPage): Promise<DelegationEvent[]> {
    const transport = this.transport(process.cwd());
    try {
      const capabilities = await this.initialize(transport);
      const sessionCapabilities = asRecord(capabilities["sessionCapabilities"]);
      if (sessionCapabilities["list"] === undefined) return [];
      const match = (
        await this.sessions(transport, "", Number.POSITIVE_INFINITY, (list) => list.some((item) => item.sessionId === sessionId))
      ).find((item) => item.sessionId === sessionId);
      if (!match) return [];
      if (capabilities["loadSession"] !== true) return sessionCapabilities["resume"] !== undefined && page.offset === 0 ? [{ type: "session", sessionId }] : [];
      const events: DelegationEvent[] = [];
      const off = transport.onNotification((notification) => {
        if (notification.method !== "session/update") return;
        const params = asRecord(notification.params);
        const update = asRecord(params["update"]);
        const content = asRecord(update["content"]);
        if (params["sessionId"] === sessionId && (update["sessionUpdate"] === "agent_message_chunk" || update["sessionUpdate"] === "user_message_chunk") && typeof content["text"] === "string") events.push({ type: "output", text: content["text"] });
      });
      try { await transport.request("session/load", { sessionId, cwd: match.cwd, mcpServers: [] }); } finally { off(); }
      return events.slice(page.offset, page.offset + page.limit);
    } finally { transport.close(); }
  }

  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const startedAt = Date.now();
    if (request.modelConfig && this.id !== "opencode" && this.id !== "deepseek-harness") return { status: "failed", diagnostic: diagnostic("handshake", "protocol", "此 ACP Agent 不支持注入 SuperCoder 模型档案"), durationMs: 0 };
    // 只读请求照常执行：可写权限本就更高，ACP 没有可强制的只读沙箱，不因此拒绝任务。
    const transport = this.transport(request.workspace, request.modelConfig);
    const candidates: AnswerCandidate[] = [];
    // ACP 的 chunk 是增量：拼成一条完整答案再交给  选择，否则只取到第一段。
    let answerBuffer = "";
    let phase: DelegationPhase = "handshake";
    let promptSent = false;
    let sessionId: string | undefined;
    let exitCode: number | null | undefined;
    let failure: string | null = null;

    const emit = (event: DelegationEvent): void => request.onEvent(event);
    const mark = (state: string): void => emit({ type: "trace", summary: `delivery:${state}` });

    const offNotification = transport.onNotification((notification) => {
      if (notification.method === "supercoder/permission") {
        emit({ type: "trace", summary: asRecord(notification.params)["allowed"] === true ? "permission:allowed" : "permission:denied" });
        return;
      }
      // session/load replays historical chunks before the new prompt. Those are
      // context, not part of the answer to the new task.
      if (!promptSent) return;
      const chunk = this.collect(notification, request, () => {
        phase = "turn";
        mark("received");
      });
      if (chunk !== null) answerBuffer += chunk;
      if (notification.method === "error") failure = "对端报错";
    });
    const offExit = transport.onExit((info) => {
      exitCode = info.code;
    });
    const onAbort = (): void => { if (sessionId) transport.notify("session/cancel", { sessionId }); transport.close(); };
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (request.signal.aborted) return { status: "aborted", durationMs: 0 };
      emit({ type: "phase", phase: "handshake" });
      const capabilities = await this.initialize(transport);
      mark("queued");

      const resumeMethod = capabilities["loadSession"] === true ? "session/load" : asRecord(capabilities["sessionCapabilities"])["resume"] !== undefined ? "session/resume" : undefined;
      if (request.resumeSessionId && !resumeMethod) throw new Error("此 Agent 未声明支持恢复会话");

      const created = (await transport.request(request.resumeSessionId ? resumeMethod! : "session/new", {
        cwd: request.workspace,
        mcpServers: [],
        ...(request.resumeSessionId === undefined ? {} : { sessionId: request.resumeSessionId }),
      })) as { sessionId?: string; configOptions?: Array<{ id?: string; category?: string }>; models?: unknown };
      if (request.resumeSessionId && created.sessionId === undefined) created.sessionId = request.resumeSessionId;
      if (created.sessionId === undefined) {
        return {
          status: "failed",
          diagnostic: diagnostic("handshake", "protocol", "session/new 没有返回 sessionId"),
          durationMs: Date.now() - startedAt,
        };
      }
      sessionId = created.sessionId;
      emit({ type: "session", sessionId });
      const selectedModel = request.modelConfig ? this.id === "deepseek-harness" ? JSON.stringify(["supercoder", request.modelConfig.model]) : `supercoder/${request.modelConfig.model}` : request.model;
      if (selectedModel !== undefined && selectedModel !== "") {
        const modelOption = created.configOptions?.find((option) => option.category === "model" || option.id === "model");
        if (modelOption?.id) {
          await transport.request("session/set_config_option", { sessionId, configId: modelOption.id, value: selectedModel });
        } else if (created.models !== undefined) {
          await transport.request("session/set_model", { sessionId, modelId: selectedModel });
        } else {
          return { status: "failed", diagnostic: diagnostic("handshake", "protocol", "该 Agent 未声明支持选择模型"), durationMs: Date.now() - startedAt };
        }
      }
      phase = "turn";

      promptSent = true;
      mark("submitted");
      emit({ type: "phase", phase: "turn" });
      const response = (await transport.request(
        "session/prompt",
        {
          sessionId,
          prompt: [{ type: "text", text: buildDelegationPrompt(request) }],
        },
        this.deps.promptTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      )) as { stopReason?: string };

      // 让还在路上的增量通知落袋：ACP 允许先返回 stopReason 再补发最后一条 chunk。
      await new Promise((resolve) => setTimeout(resolve, this.deps.drainMs ?? 50));

      if (request.signal.aborted) return promptSent ? { status: "unknown", observed: "已中断 ACP 进程，无法确认工作区副作用", since: new Date().toISOString() } : { status: "aborted", durationMs: Date.now() - startedAt };
      if (exitCode !== undefined) {
        return promptSent
          ? {
              status: "unknown",
              observed: `ACP 进程在回合结束前退出（code=${String(exitCode)}）`,
              since: new Date().toISOString(),
            }
          : {
              status: "failed",
              diagnostic: diagnostic("spawn", "process", "ACP 进程未能启动"),
              durationMs: Date.now() - startedAt,
            };
      }
      if (failure !== null) {
        return {
          status: "failed",
          diagnostic: diagnostic("turn", classify(failure), failure),
          durationMs: Date.now() - startedAt,
        };
      }

      mark("returned");
      emit({ type: "phase", phase: "collect" });
      const stopReason = response.stopReason ?? null;
      if (stopReason === "cancelled") return { status: "unknown", observed: "ACP 回合已取消，无法确认工作区副作用", since: new Date().toISOString() };
      if (stopReason === "refusal" || stopReason === "max_tokens" || stopReason === "max_turn_requests") {
        return {
          status: "failed",
          diagnostic: diagnostic(
            "collect",
            stopReason === "refusal" ? "access-policy" : "limit",
            `stopReason=${stopReason}`,
          ),
          durationMs: Date.now() - startedAt,
        };
      }
      if (stopReason !== "end_turn") return { status: "unknown", observed: `未识别的 ACP 停止原因：${String(stopReason)}`, since: new Date().toISOString() };
      if (answerBuffer !== "") candidates.push({ phase: null, text: answerBuffer });
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
      const rawMessage = messageOf(error);
      const message = request.modelConfig?.apiKey ? rawMessage.replaceAll(request.modelConfig.apiKey, "[redacted]") : rawMessage;
      if (request.signal.aborted) return promptSent ? { status: "unknown", observed: "已中断 ACP 进程，无法确认工作区副作用", since: new Date().toISOString() } : { status: "aborted", durationMs: Date.now() - startedAt };
      const category = classify(message);
      if (promptSent) {
        return { status: "unknown", observed: message, since: new Date().toISOString() };
      }
      return {
        status: "failed",
        diagnostic: diagnostic(phase === "handshake" ? "handshake" : "turn", category, message),
        durationMs: Date.now() - startedAt,
      };
    } finally {
      offNotification();
      offExit();
      request.signal.removeEventListener("abort", onAbort);
      transport.close();
    }
  }

  async cancel(_handle: DelegationHandle): Promise<void> {
    // 单次 prompt：中断由 AbortSignal 触发的成组终止负责，资源在 finally 关闭。
  }

  private collect(
    notification: RpcNotification,
    request: DelegationRequest,
    onChunk: () => void,
  ): string | null {
    if (notification.method !== "session/update") return null;
    const params = asRecord(notification.params);
    const update = asRecord(params["update"]);
    if (update["sessionUpdate"] !== "agent_message_chunk") return null;
    const content = asRecord(update["content"]);
    const text = typeof content["text"] === "string" ? content["text"] : "";
    if (text === "") return null;
    request.onEvent({ type: "output", text });
    onChunk();
    return text;
  }
}

interface AcpSession extends ProviderSessionSummary { readonly cwd: string }

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** `provider/model` 形式的 ID（OpenCode 等）取斜杠前一段作供应商；没有斜杠就不猜。 */
function providerOf(id: string): string | undefined {
  const at = id.indexOf("/");
  return at > 0 ? id.slice(0, at) : undefined;
}

/** "DeepSeek/DeepSeek V4 Pro" → { provider: "DeepSeek", label: "DeepSeek V4 Pro" }；没有斜杠返回 null。 */
function splitProvider(name: string): { provider: string; label: string } | null {
  const at = name.indexOf("/");
  if (at <= 0 || at === name.length - 1) return null;
  return { provider: name.slice(0, at).trim(), label: name.slice(at + 1).trim() };
}

/**
 * Agent 既没报告分组、ID 里也没有 `供应商/` 前缀时，按模型名里的系列词推断厂商（Antigravity 就是这样）。
 * 只认几个不会歧义的系列名；认不出就不分组，不乱猜。
 */
const VENDORS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgemini\b/i, "Google"],
  [/\bclaude\b/i, "Anthropic"],
  [/\bgpt\b|^o\d\b/i, "OpenAI"],
  [/\bdeepseek\b/i, "DeepSeek"],
  [/\bkimi\b/i, "Kimi"],
  [/\bqwen\b/i, "Qwen"],
  [/\bgrok\b/i, "xAI"],
  [/\bllama\b/i, "Meta"],
  [/\bmistral\b/i, "Mistral"],
];

function vendorOf(name: string): string | undefined {
  return VENDORS.find(([pattern]) => pattern.test(name))?.[1];
}
