import type { DelegationRequest, DelegationResult } from "../../../shared/domain/delegation.js";
import type { DelegationHandle, DelegationProvider, ProviderCapabilities, ProviderInstallation } from "../../../shared/domain/provider.js";
import { runProcess, whichBinary } from "../../boot/exec.js";
import { buildDelegationPrompt } from "../prompt.js";
import { diagnostic } from "./codex-appserver.js";

/** A user-configured noninteractive command. Prompt is sent on stdin; stdout is the answer. */
export class CommandProvider implements DelegationProvider {
  readonly capabilities: ProviderCapabilities = { readOnly: false, resume: false, effort: false, streaming: false, receiptStates: ["queued", "submitted", "returned"], fragility: "documented" };
  constructor(readonly id: string, private readonly binary: string, private readonly args: readonly string[]) {}
  async detect(): Promise<ProviderInstallation> {
    const binaryPath = await whichBinary(this.binary, process.cwd());
    return binaryPath === null ? { installed: false, reason: `找不到 ${this.binary}` } : { installed: true, binaryPath };
  }
  async listSessions() { return []; }
  async readSession() { return []; }
  async cancel(_handle: DelegationHandle): Promise<void> {}
  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    if (request.model || request.modelConfig) return { status: "failed", diagnostic: diagnostic("handshake", "protocol", "此命令适配器不支持选择模型"), durationMs: 0 };
    if (request.mode === "read-only") return { status: "failed", diagnostic: diagnostic("handshake", "access-policy", "自定义命令无法验证只读隔离"), durationMs: 0 };
    if (request.resumeSessionId) return { status: "failed", diagnostic: diagnostic("handshake", "protocol", "自定义命令不支持会话恢复"), durationMs: 0 };
    if (request.signal.aborted) return { status: "aborted", durationMs: 0 };
    const start = Date.now();
    request.onEvent({ type: "trace", summary: "delivery:queued" });
    request.onEvent({ type: "trace", summary: "delivery:submitted" });
    const result = await runProcess(this.binary, this.args, { cwd: request.workspace, input: buildDelegationPrompt(request), timeoutMs: 30 * 60 * 1000, signal: request.signal });
    if (result.timedOut || result.aborted || result.overflowed || result.code !== 0) return { status: "unknown", observed: "自定义命令未正常完成；无法确认工作区副作用", since: new Date().toISOString() };
    if (!result.stdout.trim()) return { status: "failed", diagnostic: diagnostic("collect", "invalid-result", "命令未返回输出"), durationMs: Date.now() - start };
    request.onEvent({ type: "trace", summary: "delivery:returned" });
    return { status: "ok", answer: result.stdout, durationMs: Date.now() - start };
  }
}
