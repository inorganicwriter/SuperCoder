/** OpenCode desktop local service adapter. Authentication is never inferred from logs. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DelegationEvent, DelegationRequest, DelegationResult } from "../../../shared/domain/delegation.js";
import type { DelegationHandle, DelegationProvider, ProviderCapabilities, ProviderInstallation, ProviderPage, ProviderSessionSummary } from "../../../shared/domain/provider.js";
import { buildDelegationPrompt } from "../prompt.js";
import { diagnostic } from "./codex-appserver.js";

interface Deps { readonly homeDir: string; readonly fetchImpl?: typeof fetch; readonly endpoints?: () => string[] }
const asRecord = (v: unknown): Record<string, unknown> => typeof v === "object" && v !== null ? v as Record<string, unknown> : {};
const caps: ProviderCapabilities = { readOnly: false, resume: true, effort: false, streaming: false, receiptStates: ["queued", "submitted", "returned"], fragility: "documented" };

export function desktopEndpoints(homeDir: string): string[] {
  const root = join(homeDir, "AppData", "Roaming", "ai.opencode.desktop", "logs");
  if (!existsSync(root)) return [];
  const logs = readdirSync(root).map((name) => join(root, name, "main.log")).filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs).slice(0, 3);
  const found: string[] = [];
  for (const file of logs) {
    const matches = readFileSync(file, "utf8").match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}(?!\d)/g) ?? [];
    for (const url of matches.reverse()) if (!found.includes(url)) found.push(url);
  }
  return found.slice(0, 10);
}

export class OpenCodeDesktopProvider implements DelegationProvider {
  readonly id = "opencode-desktop";
  readonly capabilities = caps;
  constructor(private readonly deps: Deps) {}
  private get fetcher(): typeof fetch { return this.deps.fetchImpl ?? fetch; }
  private async endpoint(): Promise<string | null> {
    for (const candidate of this.deps.endpoints?.() ?? desktopEndpoints(this.deps.homeDir)) {
      let url: URL;
      try { url = new URL(candidate); } catch { continue; }
      if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) continue;
      try {
        const response = await this.fetcher(new URL("/global/health", url), { signal: AbortSignal.timeout(2000), redirect: "error" });
        if (response.ok && asRecord(await response.json())["healthy"] === true) return url.origin;
      } catch { /* other candidates may be available */ }
    }
    return null;
  }
  async detect(): Promise<ProviderInstallation> {
    const url = await this.endpoint();
    return url ? { installed: true, binaryPath: url } : { installed: false, reason: "桌面服务不可访问或需要认证" };
  }
  private async call(endpoint: string, path: string, init: RequestInit = {}, workspace = ""): Promise<unknown> {
    const url = new URL(path, endpoint); if (workspace) url.searchParams.set("directory", workspace);
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(30_000), ...init, redirect: "error", headers: { "content-type": "application/json", ...init.headers } });
    if (!response.ok) throw new Error(`OpenCode 桌面服务返回 HTTP ${response.status}`);
    return response.json();
  }
  async listSessions(workspace: string, page: ProviderPage): Promise<ProviderSessionSummary[]> {
    const endpoint = await this.endpoint(); if (!endpoint) return [];
    const result = await this.call(endpoint, "/session", {}, workspace);
    if (!Array.isArray(result)) throw new Error("OpenCode 会话列表格式不符");
    return result.slice(page.offset, page.offset + page.limit).map((v) => { const item = asRecord(v), time = asRecord(item["time"]); return { sessionId: String(item["id"] ?? ""), title: String(item["title"] ?? "(无标题)"), updatedAt: new Date(typeof time["updated"] === "number" ? time["updated"] : 0).toISOString() }; });
  }
  async readSession(sessionId: string, page: ProviderPage): Promise<DelegationEvent[]> {
    const endpoint = await this.endpoint(); if (!endpoint) return [];
    const result = await this.call(endpoint, `/session/${encodeURIComponent(sessionId)}/message`);
    if (!Array.isArray(result)) throw new Error("OpenCode 会话内容格式不符");
    return result.flatMap((v) => { const parts = asRecord(v)["parts"]; return Array.isArray(parts) ? parts.flatMap((part) => { const p = asRecord(part); return p["type"] === "text" && typeof p["text"] === "string" ? [{ type: "output" as const, text: p["text"] }] : []; }) : []; }).slice(page.offset, page.offset + page.limit);
  }
  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    if (request.modelConfig) return { status: "failed", diagnostic: diagnostic("handshake", "protocol", "桌面服务不能按任务注入自定义模型，改用 ACP 接入"), durationMs: 0 };
    if (request.model && !request.model.includes("/")) return { status: "failed", diagnostic: diagnostic("handshake", "protocol", "OpenCode 模型 ID 应为 provider/model 格式"), durationMs: 0 };
    if (request.signal.aborted) return { status: "aborted", durationMs: 0 };
    const started = Date.now(); const endpoint = await this.endpoint();
    if (!endpoint) return { status: "failed", diagnostic: diagnostic("handshake", "transport", "无法连接或认证 OpenCode 桌面服务"), durationMs: Date.now() - started };
    let sessionId = request.resumeSessionId; let sent = false;
    const abort = (): void => { if (sent && sessionId) void this.call(endpoint, `/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }, request.workspace).catch(() => {}); };
    request.signal.addEventListener("abort", abort, { once: true });
    try {
      request.onEvent({ type: "trace", summary: "delivery:queued" });
      if (!sessionId) {
        const session = asRecord(await this.call(endpoint, "/session", { method: "POST", body: JSON.stringify({ title: "SuperCoder" }), signal: request.signal }, request.workspace));
        if (typeof session["id"] !== "string") throw new Error("会话响应缺少 id");
        sessionId = session["id"];
      }
      request.onEvent({ type: "session", sessionId });
      if (request.signal.aborted) return { status: "aborted", durationMs: Date.now() - started };
      sent = true; request.onEvent({ type: "trace", summary: "delivery:submitted" });
      const separator = request.model?.indexOf("/") ?? -1;
      const model = request.model && separator > 0 ? { providerID: request.model.slice(0, separator), modelID: request.model.slice(separator + 1) } : undefined;
      const result = asRecord(await this.call(endpoint, `/session/${encodeURIComponent(sessionId)}/message`, { method: "POST", signal: AbortSignal.any([request.signal, AbortSignal.timeout(30 * 60 * 1000)]), body: JSON.stringify({ ...(model ? { model } : {}), parts: [{ type: "text", text: buildDelegationPrompt(request) }] }) }, request.workspace));
      if (asRecord(result["info"])["error"]) throw new Error("OpenCode 回合返回错误");
      const parts = result["parts"];
      const answer = Array.isArray(parts) ? parts.map(asRecord).filter((p) => p["type"] === "text" && typeof p["text"] === "string").map((p) => p["text"]).join("") : "";
      if (!answer.trim()) throw new Error("OpenCode 未返回完整答案");
      request.onEvent({ type: "trace", summary: "delivery:returned" });
      return { status: "ok", answer, sessionId, durationMs: Date.now() - started };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return sent ? { status: "unknown", observed: detail, since: new Date().toISOString() } : { status: "failed", diagnostic: diagnostic("handshake", "transport", detail), durationMs: Date.now() - started };
    } finally { request.signal.removeEventListener("abort", abort); }
  }
  async cancel(_handle: DelegationHandle): Promise<void> {}
}
