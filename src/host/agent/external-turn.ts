/**
 * 由外部 Agent 担任 Superagent 的主回合执行器。
 *
 * - 无需配置 LLM API 模型即可驱动主对话。
 * - 自动绑定本地 `SuperagentMcpBridge`，将内置工具（含 `dispatch_task` 等）暴露给外部 Superagent，
 *   不支持 MCP 注入的协议（例如部分桌面版/老旧 ACP 实现）平滑降级为直连对话。
 * - 支持多轮原生会话续话，并在 `user/rewind` 回撤到绑定之前或续话握手失败时自动重开新会话。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentModelConfig, DelegationResult } from "../../shared/domain/delegation.js";
import { hasActiveProcessSandboxOverrides } from "../../shared/domain/sandbox.js";
import type { SessionEvent } from "../../shared/session/events.js";
import { ensureDir, writeJsonAtomic } from "../boot/atomic.js";
import { messageOf } from "../boot/failure.js";
import type { DockerAvailability } from "../boot/docker-runtime.js";
import type { Logger } from "../boot/logger.js";
import { createGitBaseline } from "../workspace/git.js";
import { snapshotWorkspace } from "../workspace/snapshot.js";
import type { AgentSandboxPreferences, CompiledSandboxEnv } from "../delegation/sandbox-preferences.js";
import type { AgentNetworkProxy } from "../delegation/network-proxy.js";
import type { ProviderSelect, ResolvedProvider } from "../delegation/provider-select.js";
import type { SessionHandle } from "../session/handle.js";
import type { ApprovalBroker } from "../tools/approval.js";
import type { DispatchPreflight } from "../tools/builtin/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import { inRewindWindow } from "./context.js";
import { buildSystemPrompt } from "./prompt/system.js";
import type { SuperagentMcpBridge } from "./superagent-mcp.js";
import type { SuperagentPreferences } from "./superagent-preferences.js";
import type { TurnStatus } from "./turn.js";

export interface ExternalTurnDeps {
  readonly select: ProviderSelect;
  readonly sandboxes: AgentSandboxPreferences;
  readonly networkProxy: AgentNetworkProxy;
  readonly detectDocker?: () => Promise<DockerAvailability>;
  readonly superagentPrefs: SuperagentPreferences;
  readonly superagentMcp: SuperagentMcpBridge;
  readonly registry: ToolRegistry;
  readonly approvals: ApprovalBroker;
  readonly logger: Logger;
  readonly language: () => "zh-CN" | "en";
  readonly workspacePath: (session: SessionHandle) => string;
  readonly checkAgentModel?: (agentId: string) => DispatchPreflight;
  readonly modelConfigFor?: (agentId: string, selection: string | undefined) => AgentModelConfig | undefined;
  readonly selectedModelOf?: (agentId: string) => string | undefined;
  readonly sharedContext?: (session: SessionHandle) => string;
}

export interface ExternalTurnInput {
  readonly session: SessionHandle;
  readonly turnId: string;
  readonly text: string;
  readonly attachments: readonly string[];
  readonly agentId: string;
  readonly signal: AbortSignal;
}

function mergeLoopbackNoProxy(
  env: Record<string, string | undefined>,
  forDocker: boolean,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  const noProxyKey = Object.keys(out).find((k) => k === "NO_PROXY") ?? "NO_PROXY";
  const lowerKey = Object.keys(out).find((k) => k === "no_proxy");
  const existing = String(out[noProxyKey] ?? (lowerKey === undefined ? "" : out[lowerKey]) ?? "");
  const items = new Set(
    existing
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );
  items.add("127.0.0.1");
  items.add("localhost");
  if (forDocker) items.add("host.docker.internal");
  const merged = [...items].join(",");
  out[noProxyKey] = merged;
  if (process.platform !== "win32" || lowerKey !== undefined) {
    out[lowerKey ?? "no_proxy"] = merged;
  }
  return out;
}

function formatRecentHistory(
  events: readonly SessionEvent[],
  rewind: { readonly toSeq: number; readonly seq: number } | null,
  beforeSeq: number,
  maxChars = 10_000,
): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.seq >= beforeSeq || !inRewindWindow(event.seq, rewind)) continue;
    if (event.type === "user/message") {
      lines.push(`User: ${event.text}`);
    } else if (event.type === "assistant/message" && event.text.trim() !== "") {
      lines.push(`Assistant: ${event.text}`);
    }
  }
  if (lines.length === 0) return "";
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (total + line.length > maxChars && kept.length > 0) break;
    kept.unshift(line);
    total += line.length + 1;
  }
  return kept.join("\n\n");
}

function buildFreshSuperagentInstruction(input: {
  readonly system: string;
  readonly superagentId: string;
  readonly mcpEnabled: boolean;
  readonly shared: string;
  readonly history: string;
  readonly userText: string;
}): string {
  const sections = [input.system];
  if (input.mcpEnabled) {
    sections.push(
      `MCP Orchestration: You have direct access to the "supercoder" MCP server tools (including list_available_agents and dispatch_task). Use them whenever delegating specialized or parallel subtasks to other external agents. Never call dispatch_task targeting your own agent ID ("${input.superagentId}"); handle work directly or delegate to another agent.`,
    );
  }
  if (input.shared.trim() !== "") {
    sections.push(`Workspace shared context:\n${input.shared}`);
  }
  if (input.history.trim() !== "") {
    sections.push(`Earlier conversation summary:\n${input.history}`);
  }
  sections.push(`User request:\n${input.userText}`);
  return sections.join("\n\n");
}

function failureReason(result: Extract<DelegationResult, { status: "failed" }>): string {
  const d = result.diagnostic;
  return d.detail ? `${d.stage}/${d.category}: ${d.detail}` : `${d.stage}/${d.category}`;
}

export class ExternalTurnRunner {
  constructor(private readonly deps: ExternalTurnDeps) {}

  async run(input: ExternalTurnInput): Promise<TurnStatus> {
    const { session, agentId, signal } = input;
    const language = this.deps.language();
    const workspace = this.deps.workspacePath(session);
    let sawUncertain = false;
    let status: TurnStatus = "completed";
    let reason: string | undefined;

    session.append("turn/start", { chatId: session.sessionId });
    const userMsg = session.append("user/message", {
      text: input.text,
      attachments: [...input.attachments],
    });

    const preflightModel = this.deps.checkAgentModel?.(agentId);
    if (preflightModel !== undefined && preflightModel.status === "error") {
      session.append("assistant/message", { step: 0, text: preflightModel.message });
      session.append("turn/end", { status: "completed", reason: "agent_unavailable" });
      return "completed";
    }

    const sandbox = this.deps.sandboxes.get(agentId, session.meta.workspace);
    const isDockerBackend = sandbox.backend.kind === "docker";
    if (isDockerBackend && this.deps.detectDocker !== undefined) {
      const dockerStatus = await this.deps.detectDocker();
      if (!dockerStatus.available) {
        const msg = `外部 Superagent ${agentId} 已启用 Docker 容器隔离，但当前未检测到可用 Docker 服务：${dockerStatus.reason ?? "请先启动 Docker"}。`;
        session.append("assistant/message", { step: 0, text: msg });
        session.append("turn/end", { status: "completed", reason: "agent_unavailable" });
        return "completed";
      }
    }

    let resolved: ResolvedProvider;
    try {
      const requireProcessSandbox = hasActiveProcessSandboxOverrides(sandbox);
      const candidates = await this.deps.select.resolveCandidates(agentId, {
        requireProcessSandbox,
        allowDockerFallback: isDockerBackend,
      });
      resolved = candidates[0]!;
    } catch (error) {
      session.append("assistant/message", { step: 0, text: messageOf(error) });
      session.append("turn/end", { status: "completed", reason: "agent_unavailable" });
      return "completed";
    }

    let compiledEnv: CompiledSandboxEnv | undefined;
    let mcpScope: ReturnType<SuperagentMcpBridge["registerTurn"]> | null = null;

    try {
      compiledEnv = await this.deps.sandboxes.compileEnv(agentId, {
        proxy: this.deps.networkProxy,
        workspaceId: session.meta.workspace,
      });

      const dockerSpec = compiledEnv.docker;
      const canUseMcp = dockerSpec?.networkIsolation !== "none";
      if (canUseMcp) {
        const forDocker = dockerSpec !== undefined;
        await (forDocker ? this.deps.superagentMcp.startDocker() : this.deps.superagentMcp.start());
        mcpScope = this.deps.superagentMcp.registerTurn(
          {
            session,
            workspacePath: workspace,
            superagentId: agentId,
            signal,
            onUncertain: () => {
              sawUncertain = true;
            },
          },
          { forDocker },
        );
      }

      const view = session.view();
      const rewind = view.rewind === null ? null : { toSeq: view.rewind.toSeq, seq: view.rewind.seq };
      const savedThread = this.deps.superagentPrefs.getSessionThread(session.sessionId, agentId);
      let resumeSessionId: string | undefined;
      if (savedThread !== null) {
        if (inRewindWindow(savedThread.atSeq, rewind)) {
          resumeSessionId = savedThread.nativeSessionId;
        } else {
          this.deps.superagentPrefs.clearSessionThread(session.sessionId, agentId);
        }
      }

      const selectedModel = this.deps.selectedModelOf?.(agentId);
      const modelConfig = this.deps.modelConfigFor?.(agentId, selectedModel);
      const toolNames = this.deps.registry.names();
      const system = buildSystemPrompt({
        workspacePath: workspace,
        toolNames,
        language,
        model: selectedModel ?? resolved.provider.id,
      });
      const shared = this.deps.sharedContext?.(session) ?? "";
      const history = formatRecentHistory(session.allEvents(), rewind, userMsg.seq);
      const freshInstruction = buildFreshSuperagentInstruction({
        system,
        superagentId: agentId,
        mcpEnabled: mcpScope !== null,
        shared,
        history,
        userText: input.text,
      });

      session.append("request/header", {
        step: 0,
        provider: `agent:${agentId}`,
        model: selectedModel ?? resolved.provider.id,
        system,
        toolNames: mcpScope !== null ? toolNames : [],
      });

      const envWithNoProxy =
        mcpScope === null
          ? (compiledEnv.env as Record<string, string | undefined>)
          : mergeLoopbackNoProxy(compiledEnv.env as Record<string, string | undefined>, dockerSpec !== undefined);

      let capturedSessionId: string | undefined;
      const runDelegate = async (resume: string | undefined, instruction: string): Promise<DelegationResult> =>
        resolved.provider.delegate({
          childId: input.turnId,
          agentId,
          workspace: workspace || process.cwd(),
          goal: input.text,
          instruction,
          mode: "write",
          taskType: "general",
          ...(selectedModel !== undefined && modelConfig === undefined ? { model: selectedModel } : {}),
          ...(modelConfig === undefined ? {} : { modelConfig }),
          env: envWithNoProxy,
          ...(dockerSpec === undefined ? {} : { docker: dockerSpec }),
          ...(resume === undefined ? {} : { resumeSessionId: resume }),
          ...(mcpScope === null ? {} : { superagentMcp: mcpScope.endpoint }),
          signal,
          onEvent: (event) => {
            if (event.type === "output") {
              session.publishTransient({
                type: "request/delta",
                seq: session.lastSeq + 1,
                at: new Date().toISOString(),
                step: 0,
                text: event.text,
              });
            } else if (event.type === "session") {
              capturedSessionId = event.sessionId;
            }
          },
        });

      if (workspace !== "" && existsSync(workspace)) {
        try {
          const snapshot = snapshotWorkspace(workspace);
          session.append("snapshot/taken", {
            taskId: input.turnId,
            files: snapshot.files.map((file) => ({
              path: file.path,
              mtimeMs: file.mtimeMs,
              size: file.size,
            })),
          });
          const gitRef = await createGitBaseline(workspace);
          if (gitRef !== null) {
            const baselineDir = join(dirname(session.logPath), "baselines");
            ensureDir(baselineDir);
            writeJsonAtomic(join(baselineDir, `${input.turnId}.json`), {
              taskId: input.turnId,
              gitRef,
            });
          }
        } catch (error) {
          this.deps.logger.warn(
            { error: messageOf(error), turnId: input.turnId },
            "外部 Superagent 写入前快照失败",
          );
        }
      }

      let result = await runDelegate(resumeSessionId, resumeSessionId === undefined ? freshInstruction : "");
      if (
        resumeSessionId !== undefined &&
        result.status === "failed" &&
        ["detect", "spawn", "handshake"].includes(result.diagnostic.stage) &&
        !signal.aborted
      ) {
        this.deps.superagentPrefs.clearSessionThread(session.sessionId, agentId);
        capturedSessionId = undefined;
        result = await runDelegate(undefined, freshInstruction);
      }

      if (result.status === "ok") {
        const assistantMsg = session.append("assistant/message", { step: 0, text: result.answer });
        const finalSessionId = result.sessionId ?? capturedSessionId;
        if (finalSessionId !== undefined && finalSessionId !== "") {
          this.deps.superagentPrefs.setSessionThread(session.sessionId, agentId, finalSessionId, assistantMsg.seq);
        }
        status = sawUncertain ? "unknown" : "completed";
      } else if (result.status === "failed") {
        const detail = failureReason(result);
        session.append("assistant/attempt", { step: 0, reason: detail });
        session.append("assistant/message", {
          step: 0,
          text: `${language === "zh-CN" ? "外部 Superagent 执行失败" : "External Superagent failed"}：${detail}`,
        });
        reason = "agent_error";
        status = sawUncertain ? "unknown" : "completed";
      } else if (result.status === "unknown") {
        session.append("assistant/message", {
          step: 0,
          text: result.observed,
        });
        status = "unknown";
      } else {
        status = sawUncertain ? "unknown" : "interrupted";
      }
    } catch (error) {
      this.deps.logger.error({ error, turnId: input.turnId, agentId }, "外部 Superagent 回合异常");
      session.append("assistant/message", {
        step: 0,
        text: `${language === "zh-CN" ? "回合异常中止" : "Turn aborted by an internal error"}：${messageOf(error)}`,
      });
      status = sawUncertain ? "unknown" : "interrupted";
    } finally {
      mcpScope?.dispose();
      compiledEnv?.dispose();
      this.deps.approvals.resetTurnScope();
    }

    session.append("turn/end", {
      status,
      ...(reason === undefined ? {} : { reason }),
    });
    return status;
  }
}
