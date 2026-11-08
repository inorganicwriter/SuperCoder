/**
 * Claude Code 接入。
 *
 * `claude -p --output-format json` 是一次性非交互调用：prompt 走 stdin，
 * 标准输出是一整块 JSON，`result` 是答案，`session_id` 可以拿去 `--resume` 续话。
 * 有官方文档支撑，因此 `fragility: "documented"`。
 *
 * 只读任务用 `--permission-mode plan`：这是 Claude Code 自己的只读模式，
 * 只读策略实现：在权限层拦截文件写入与命令执行操作。
 */

import type {
  DelegationEvent,
  DelegationRequest,
  DelegationResult,
  SafeDiagnostic,
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
import { runProcess, whichBinary, type RunResult } from "../../boot/exec.js";
import { messageOf } from "../../boot/failure.js";
import { buildDelegationPrompt } from "../prompt.js";
import { classify, diagnostic } from "./codex-appserver.js";

export const CLAUDE_CODE_ID = "claude-code";

export const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = {
  readOnly: true,
  resume: true,
  effort: false,
  streaming: false,
  receiptStates: ["queued", "submitted", "returned"],
  fragility: "documented",
};

const CLAUDE_MODEL_ALIASES = ["fable", "opus", "sonnet", "haiku"] as const;

/** 常见安装位置：WinGet 的 shim 在 PATH 上，原生安装则落在 ~/.local/bin。 */
const BINARY_CANDIDATES = ["claude", "claude.cmd"];

export interface ClaudeCodeDeps {
  readonly binary?: string;
  /** 测试注入：回放录制的 stdout / 退出码。 */
  readonly run?: (args: readonly string[], stdin: string, onStdout?: (chunk: string) => void) => Promise<RunResult>;
  readonly detect?: () => Promise<ProviderInstallation>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class ClaudeCodeProvider implements DelegationProvider {
  readonly id = CLAUDE_CODE_ID;
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;

  constructor(private readonly deps: ClaudeCodeDeps = {}) {}

  async detect(): Promise<ProviderInstallation> {
    if (this.deps.detect !== undefined) return this.deps.detect();
    const binary = this.deps.binary;
    if (binary !== undefined) {
      const found = await whichBinary(binary, process.cwd());
      return found === null
        ? { installed: false, reason: `未找到 ${binary}，请安装后重新探测。` }
        : { installed: true, binaryPath: found };
    }
    for (const candidate of BINARY_CANDIDATES) {
      const found = await whichBinary(candidate, process.cwd());
      if (found !== null) return { installed: true, binaryPath: found };
    }
    return {
      installed: false,
      reason: "未在 PATH 中找到 claude，请安装后重新探测。",
    };
  }

  async listModels(_workspace: string): Promise<ProviderModel[]> {
    // CLI 没有列模型的接口；给出 `--model` 接受的别名，各自指向该系列的最新模型。
    return CLAUDE_MODEL_ALIASES.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1), provider: "Anthropic" }));
  }

  async listSessions(_workspace: string, _page: ProviderPage): Promise<ProviderSessionSummary[]> {
    // 历史由 ClaudeStoreProbe 从 ~/.claude/projects 读，这一级只负责任务分派。
    return [];
  }

  async readSession(_sessionId: string, _page: ProviderPage): Promise<DelegationEvent[]> {
    return [];
  }

  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const startedAt = Date.now();
    if (request.modelConfig) {
      return {
        status: "failed",
        diagnostic: diagnostic("handshake", "protocol", "Claude Code 不接受注入的 API 档案，请用它的登录态或环境变量"),
        durationMs: 0,
      };
    }
    if (request.signal.aborted) return { status: "aborted", durationMs: 0 };

    // stream-json + partial messages：正文按片段实时送回，最后一行 result 给最终答案与会话 ID。
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
    // plan 是 Claude Code 的只读模式：能读、能查，但改不了文件。
    args.push("--permission-mode", request.mode === "read-only" ? "plan" : "acceptEdits");
    if (request.model) args.push("--model", request.model);
    if (request.resumeSessionId !== undefined && request.resumeSessionId !== "") {
      args.push("--resume", request.resumeSessionId);
    }
    const stdin = buildDelegationPrompt(request);
    const emitDelivery = (state: string): void =>
      request.onEvent({ type: "trace", summary: `delivery:${state}` });

    let submitted = false;
    const stream = createStreamParser((text) => request.onEvent({ type: "output", text }));
    const onStdout = (chunk: string): void => {
      // 第一段输出到达就说明 Claude Code 已经接手了这次任务。
      if (!submitted) { submitted = true; emitDelivery("submitted"); }
      stream.push(chunk);
    };

    try {
      request.onEvent({ type: "phase", phase: "spawn" });
      emitDelivery("queued");
      const result =
        this.deps.run !== undefined
          ? await this.deps.run(args, stdin, onStdout)
          : await runProcess(this.deps.binary ?? "claude", args, {
              cwd: request.workspace,
              input: stdin,
              timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              signal: request.signal,
              onStdout,
            });
      stream.end();
      if (!submitted) emitDelivery("submitted");

      if (request.signal.aborted) {
        return { status: "unknown", observed: "Claude Code 已中断，无法确认工作区副作用", since: new Date().toISOString() };
      }
      if (result.overflowed) {
        return {
          status: "unknown",
          observed: "Claude Code 输出超过上限，进程已被终止；无法确认工作区副作用",
          since: new Date().toISOString(),
        };
      }
      if (result.timedOut) {
        return {
          status: "unknown",
          observed: `Claude Code 超时（${Math.round((this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} 秒）后被终止，无法确认是否已改动工作区`,
          since: new Date().toISOString(),
        };
      }

      request.onEvent({ type: "phase", phase: "collect" });
      emitDelivery("returned");

      const parsed = parseClaudeOutput(result.stdout);
      if (parsed === null) {
        const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 200);
        return {
          status: "failed",
          diagnostic: diagnostic("collect", "invalid-result", detail === "" ? "Claude Code 没有返回可解析的 JSON" : detail),
          durationMs: Date.now() - startedAt,
        };
      }
      if (parsed.sessionId !== undefined) {
        request.onEvent({ type: "session", sessionId: parsed.sessionId });
      }
      if (result.code !== 0 || parsed.isError) {
        const detail = (parsed.result ?? (result.stderr.trim() || "")).slice(0, 200);
        return {
          status: "failed",
          diagnostic: diagnostic("turn", classify(detail), detail),
          durationMs: Date.now() - startedAt,
        };
      }
      if (parsed.result === undefined || parsed.result.trim() === "") {
        return {
          status: "failed",
          diagnostic: diagnostic("collect", "invalid-result", "Claude Code 返回了空答案"),
          durationMs: Date.now() - startedAt,
        };
      }
      return {
        status: "ok",
        answer: parsed.result,
        ...(parsed.sessionId === undefined ? {} : { sessionId: parsed.sessionId }),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const message = messageOf(error);
      if (request.signal.aborted) return { status: "aborted", durationMs: Date.now() - startedAt };
      return {
        status: "failed",
        diagnostic: diagnostic("spawn", classify(message), message) as SafeDiagnostic,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async cancel(_handle: DelegationHandle): Promise<void> {
    // 单次调用：中断由 AbortSignal 触发的成组终止负责。
  }
}

export interface ClaudeOutput {
  readonly result: string | undefined;
  readonly sessionId: string | undefined;
  readonly isError: boolean;
}

/**
 * 解析 `--output-format json` 的输出。
 *
 * 正常是一条 JSON 对象；出错时 CLI 也可能往 stderr 写人类可读文本，
 * 这里解析不了一律返回 null，由调用方判成 `invalid-result`，不当成答案。
 */
export function parseClaudeOutput(stdout: string): ClaudeOutput | null {
  const text = stdout.trim();
  if (text === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 有些版本会在 JSON 前后夹带日志行：取最后一条能解析的对象。
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("{"));
    for (let at = lines.length - 1; at >= 0; at -= 1) {
      try {
        parsed = JSON.parse(lines[at]!);
        break;
      } catch {
        continue;
      }
    }
    if (parsed === undefined) return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  return {
    result: typeof record["result"] === "string" ? record["result"] : undefined,
    sessionId: typeof record["session_id"] === "string" ? record["session_id"] : undefined,
    isError: record["is_error"] === true,
  };
}

/**
 * 逐行解析 stream-json：只转发正文的 text_delta（思考过程不算输出）。
 * 旧版本 CLI 不支持 --include-partial-messages 时没有 delta，就退回转发整条 assistant 消息的正文。
 */
export function createStreamParser(emit: (text: string) => void): { push(chunk: string): void; end(): void } {
  let buffer = "";
  let sawDelta = false;
  const handle = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null) return;
      event = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (event["type"] === "stream_event") {
      const inner = event["event"] as Record<string, unknown> | undefined;
      const delta = inner?.["delta"] as Record<string, unknown> | undefined;
      if (inner?.["type"] === "content_block_delta" && delta?.["type"] === "text_delta" && typeof delta["text"] === "string") {
        sawDelta = true;
        emit(delta["text"]);
      }
      return;
    }
    if (event["type"] === "assistant" && !sawDelta) {
      const message = event["message"] as Record<string, unknown> | undefined;
      const content = Array.isArray(message?.["content"]) ? (message["content"] as unknown[]) : [];
      for (const part of content) {
        const item = part as Record<string, unknown>;
        if (item["type"] === "text" && typeof item["text"] === "string" && item["text"] !== "") emit(item["text"]);
      }
    }
  };
  return {
    push(chunk) {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        handle(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
      }
    },
    end() {
      if (buffer !== "") handle(buffer);
      buffer = "";
    },
  };
}
