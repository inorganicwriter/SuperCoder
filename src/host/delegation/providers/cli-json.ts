/**
 * CLI JSON 接入。
 *
 * 做法：prompt 走 stdin，逐行读 JSONL，最后读 `-o` 文件拿最终答案。
 * 有官方文档支撑，但输出格式比 app-server 松，因此 `fragility: "documented"`。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ProviderPage,
  ProviderSessionSummary,
} from "../../../shared/domain/provider.js";
import { runProcess, whichBinary, type RunResult } from "../../boot/exec.js";
import { messageOf } from "../../boot/failure.js";
import { selectAnswer, type AnswerCandidate } from "../answer.js";
import { buildDelegationPrompt } from "../prompt.js";
import { classify, codexBinary, detectCodex, diagnostic } from "./codex-appserver.js";

export const CLI_JSON_ID = "codex-cli";

export const CLI_JSON_CAPABILITIES: ProviderCapabilities = {
  // 只读任务走 Codex 自己的 read-only 沙箱，是对方强制的。
  readOnly: true,
  resume: true,
  effort: false,
  streaming: false,
  // 没有中间回执：CLI 只在退出时结算。
  receiptStates: ["queued", "submitted", "returned"],
  fragility: "documented",
};

export interface CliJsonDeps {
  readonly binary?: string;
  /** 测试注入：回放录制的 stdout / 退出码。 */
  readonly run?: (args: readonly string[], stdin: string) => Promise<RunResult>;
  readonly detect?: () => Promise<ProviderInstallation>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export class CliJsonProvider implements DelegationProvider {
  readonly id: string;
  readonly capabilities = CLI_JSON_CAPABILITIES;

  constructor(private readonly deps: CliJsonDeps = {}) {
    this.id = CLI_JSON_ID;
  }

  async detect(): Promise<ProviderInstallation> {
    if (this.deps.detect !== undefined) return this.deps.detect();
    if (this.deps.binary === undefined) return detectCodex();
    const binaryPath = await whichBinary(this.deps.binary, process.cwd());
    return binaryPath === null
      ? { installed: false, reason: `找不到 ${this.deps.binary}` }
      : { installed: true, binaryPath };
  }

  async listSessions(_workspace: string, _page: ProviderPage): Promise<ProviderSessionSummary[]> {
    // CLI 没有列历史会话的接口：这一级只能任务分派，读历史交给第 4 级只读探测。
    return [];
  }

  async readSession(_sessionId: string, _page: ProviderPage): Promise<DelegationEvent[]> {
    return [];
  }

  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const startedAt = Date.now();
    if (request.modelConfig) return { status: "failed", diagnostic: diagnostic("handshake", "protocol", "此 CLI 备用接入不支持 SuperCoder API 档案"), durationMs: 0 };
    const dir = mkdtempSync(join(tmpdir(), "supercoder-cli-"));
    const outFile = join(dir, "last-message.txt");
    const emit = (event: DelegationEvent): void => request.onEvent(event);
    const emitDelivery = (state: string): void => emit({ type: "trace", summary: `delivery:${state}` });

    const args = ["exec", "--json", "-o", outFile, "--sandbox", request.mode === "read-only" ? "read-only" : "workspace-write"];
    if (request.model) args.push("--model", request.model);
    if (request.resumeSessionId !== undefined && request.resumeSessionId !== "") {
      args.push("resume", request.resumeSessionId);
    }
    const stdin = buildDelegationPrompt(request);

    try {
      emit({ type: "phase", phase: "spawn" });
      emitDelivery("queued");
      const result =
        this.deps.run !== undefined
          ? await this.deps.run(args, stdin)
          : await runProcess(this.deps.binary ?? codexBinary(), args, {
              cwd: request.workspace,
              input: stdin,
              timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              signal: request.signal,
            });
      emitDelivery("submitted");

      if (request.signal.aborted) return { status: "unknown", observed: "CLI 已中断，无法确认工作区副作用", since: new Date().toISOString() };
      if (result.overflowed) {
        return {
          status: "unknown",
          observed: "执行者输出超过上限，进程已被终止；无法确认工作区副作用",
          since: new Date().toISOString(),
        };
      }
      if (result.timedOut) {
        return {
          status: "unknown",
          observed: `CLI 超时（${Math.round((this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} 秒）后被终止，无法确认是否已改动工作区`,
          since: new Date().toISOString(),
        };
      }

      const candidates = parseJsonLines(result.stdout);
      const fileAnswer = readOutFile(outFile);
      emit({ type: "phase", phase: "collect" });
      emitDelivery("returned");

      if (result.code !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 200);
        return {
          status: "failed",
          diagnostic: diagnostic("turn", classify(detail), detail),
          durationMs: Date.now() - startedAt,
        };
      }

      if (fileAnswer !== null && fileAnswer.trim() !== "") {
        return { status: "ok", answer: fileAnswer, durationMs: Date.now() - startedAt };
      }
      const selection = selectAnswer(candidates);
      if (!selection.ok) {
        return {
          status: "failed",
          diagnostic: diagnostic("collect", "invalid-result", selection.detail),
          durationMs: Date.now() - startedAt,
        };
      }
      return { status: "ok", answer: selection.answer, durationMs: Date.now() - startedAt };
    } catch (error) {
      const message = messageOf(error);
      if (request.signal.aborted) return { status: "aborted", durationMs: Date.now() - startedAt };
      return {
        status: "failed",
        diagnostic: diagnostic("spawn", classify(message), message) as SafeDiagnostic,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async cancel(_handle: DelegationHandle): Promise<void> {
    // 单次 exec：中断由 AbortSignal 触发的成组终止负责。
  }
}

/**
 * 逐行解析 CLI 的 JSONL。
 *
 * 旧版本用 `msg`，新版本用 `text`/`phase`；两种都认，认不出就跳过。
 * 关键点：没有 phase 的文本当兼容候选，不直接当最终答案。
 */
export function parseJsonLines(stdout: string): AnswerCandidate[] {
  const candidates: AnswerCandidate[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("[")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const nested = typeof record["msg"] === "object" && record["msg"] !== null
      ? (record["msg"] as Record<string, unknown>)
      : record;
    // 工具调用出现在文本之后：之前的文本只能是中间答案。
    if (nested["type"] === "tool_call" || nested["type"] === "tool_result") {
      for (let at = 0; at < candidates.length; at += 1) {
        const previous = candidates[at];
        if (previous !== undefined) candidates[at] = { ...previous, toolCallAfter: true };
      }
      continue;
    }
    const text =
      typeof nested["message"] === "string"
        ? nested["message"]
        : typeof nested["text"] === "string"
          ? nested["text"]
          : typeof nested["content"] === "string"
            ? nested["content"]
            : undefined;
    if (text === undefined || text === "") continue;
    candidates.push({
      phase: typeof nested["phase"] === "string" ? nested["phase"] : null,
      text,
    });
  }
  return candidates;
}

function readOutFile(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
