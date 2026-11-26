/**
 * Part 1：多 Agent 并行编排验证。
 *
 * 覆盖：
 * - `partitionToolCalls` 的安全分批规则（只读/Worktree 并行、共享工作区串行、同 Agent 原生会话防冲突、验证屏障、`maxParallel`）
 * - `TurnRunner` 同一步并发执行（用双重进入屏障证明真实并发，并校验乱序完成后的上下文配对）
 * - `ApprovalBroker` 同一步并发审批在用户选择 "记住" 时自动批量放行
 * - `list_available_agents` 对开启 `worktree` 的 Agent 选择性暴露 `parallel_write: true`
 */

import { describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/host/boot/config.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createTestBackend, SecretStore } from "../../src/host/boot/secrets.js";
import { partitionToolCalls, type PreparedToolCall } from "../../src/host/agent/parallel.js";
import { TurnRunner } from "../../src/host/agent/turn.js";
import { ModelCatalog } from "../../src/host/models/catalog.js";
import type { LlmChunk, LlmClient, LlmRequest } from "../../src/host/models/llm.js";
import { SessionStore } from "../../src/host/session/store.js";
import { registerBuiltinTools } from "../../src/host/tools/builtin/index.js";
import { ApprovalBroker } from "../../src/host/tools/approval.js";
import { toolOk } from "../../src/host/tools/outcome.js";
import { ToolPipeline } from "../../src/host/tools/pipeline.js";
import { ToolRegistry } from "../../src/host/tools/registry.js";
import { BUILTIN_TOOLS } from "../../src/shared/domain/builtin-tools.js";
import { AgentSandboxProfileSchema } from "../../src/shared/domain/sandbox.js";
import { seedModel, TEST_MODEL } from "../helpers/model.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

function validCall(id: string, name: string, args: unknown): PreparedToolCall {
  return {
    kind: "valid",
    call: { id, name, arguments: JSON.stringify(args) },
    args,
  };
}

describe("Parallel Tool Orchestration", () => {
  it("partitions independent read-only and worktree-write dispatches safely", () => {
    const calls: PreparedToolCall[] = [
      validCall("c1", "dispatch_task", { agent_id: "codex", instruction: "edit 1", task_type: "implement", allow_write: true }),
      validCall("c2", "dispatch_task", { agent_id: "claude-code", instruction: "edit 2", task_type: "implement", allow_write: true }),
      validCall("c3", "run_workspace_verification", {}),
      validCall("c4", "query_task_status", { task_id: "t1" }),
      validCall("c5", "list_available_agents", {}),
    ];

    // 两个都支持并行 write（如均开启了 worktree）
    const parallelWorktree = partitionToolCalls(calls, {
      canParallelDispatch: () => true,
    });
    expect(parallelWorktree.map((b) => b.map((x) => x.call.id))).toEqual([
      ["c1", "c2"],
      ["c3"],
      ["c4", "c5"],
    ]);

    // 只开启了只读并行（shared 写锁下不允许并行 write）
    const sharedWrite = partitionToolCalls(calls, {
      canParallelDispatch: (_agent, mode) => mode === "read-only",
    });
    expect(sharedWrite.map((b) => b.map((x) => x.call.id))).toEqual([
      ["c1"],
      ["c2"],
      ["c3"],
      ["c4", "c5"],
    ]);
  });

  it("serializes same-agent auto-continue dispatches unless new_session is true or explicit session_ids differ", () => {
    const sameAgentDefault: PreparedToolCall[] = [
      validCall("a1", "dispatch_task", { agent_id: "codex", instruction: "read 1", task_type: "review", allow_write: false }),
      validCall("a2", "dispatch_task", { agent_id: "codex", instruction: "read 2", task_type: "review", allow_write: false }),
    ];
    expect(partitionToolCalls(sameAgentDefault).map((b) => b.map((x) => x.call.id))).toEqual([
      ["a1"],
      ["a2"],
    ]);

    const sameAgentNewSessions: PreparedToolCall[] = [
      validCall("n1", "dispatch_task", { agent_id: "codex", instruction: "r1", task_type: "review", allow_write: false, new_session: true }),
      validCall("n2", "dispatch_task", { agent_id: "codex", instruction: "r2", task_type: "review", allow_write: false, new_session: true }),
    ];
    expect(partitionToolCalls(sameAgentNewSessions).map((b) => b.map((x) => x.call.id))).toEqual([
      ["n1", "n2"],
    ]);

    const sameExplicitSession: PreparedToolCall[] = [
      validCall("s1", "dispatch_task", { agent_id: "codex", instruction: "a", task_type: "review", allow_write: false, session_id: "sid-1" }),
      validCall("s2", "dispatch_task", { agent_id: "codex", instruction: "b", task_type: "review", allow_write: false, session_id: "sid-1" }),
    ];
    expect(partitionToolCalls(sameExplicitSession).map((b) => b.map((x) => x.call.id))).toEqual([
      ["s1"],
      ["s2"],
    ]);

    // maxParallel 上限
    const fiveReads = ["1", "2", "3", "4", "5"].map((id) => validCall(id, "query_task_status", { task_id: id }));
    expect(partitionToolCalls(fiveReads, { maxParallel: 2 }).map((b) => b.map((x) => x.call.id))).toEqual([
      ["1", "2"],
      ["3", "4"],
      ["5"],
    ]);
  });

  it("executes parallel dispatches concurrently in TurnRunner and pairs out-of-order results cleanly", async () => {
    const home = makeTempHome("sc-par-turn-");
    const store = new SessionStore({ paths: home.paths, logger });
    const session = store.get(store.create("ws1", "并行回合").sessionId);
    const settings = new SettingsStore(home.paths);
    seedModel(settings);
    const secrets = new SecretStore(home.paths.secretsFile, createTestBackend());
    const models = new ModelCatalog({ settings, secrets });

    const capturedRequests: LlmRequest[] = [];
    let turnStep = 0;
    const mockClient: LlmClient = {
      id: "mock-parallel",
      async *stream(request: LlmRequest): AsyncGenerator<LlmChunk> {
        capturedRequests.push(request);
        if (turnStep === 0) {
          turnStep += 1;
          yield {
            type: "tool-call",
            call: {
              id: "call_1",
              name: "dispatch_task",
              arguments: JSON.stringify({ agent_id: "codex", instruction: "part 1", task_type: "implement", allow_write: true }),
            },
          };
          yield {
            type: "tool-call",
            call: {
              id: "call_2",
              name: "dispatch_task",
              arguments: JSON.stringify({ agent_id: "claude-code", instruction: "part 2", task_type: "implement", allow_write: true }),
            },
          };
          yield { type: "done" };
          return;
        }
        yield { type: "text", text: "全部完成" };
        yield { type: "done" };
      },
    };
    models.clientFor = () => mockClient;

    let releaseBoth: (() => void) | null = null;
    let entered = 0;
    const bothInside = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    const registry = new ToolRegistry();
    const spec = BUILTIN_TOOLS["dispatch_task"];
    registry.register(spec, async (raw) => {
      const args = raw as { agent_id: string };
      entered += 1;
      if (entered === 2) releaseBoth?.();
      await bothInside;
      // 故意让 call_1 比 call_2 慢结束，验证乱序结算不影响上下文构建
      if (args.agent_id === "codex") {
        await new Promise((r) => setTimeout(r, 25));
      }
      return toolOk({ task_id: `t_${args.agent_id}`, state: "returned", result: { status: "ok", answer: args.agent_id, durationMs: 1 } });
    });

    const approvals = new ApprovalBroker(logger);
    const pipeline = new ToolPipeline({ registry, approvals, policy: () => "never", logger });
    const runner = new TurnRunner({
      models,
      tools: pipeline,
      registry,
      approvals,
      logger,
      language: () => "zh-CN",
      workspacePath: () => home.home,
      canParallelDispatch: () => true,
    });

    try {
      const status = await runner.run({
        session,
        turnId: "turn_par",
        text: "并行实现两个模块",
        attachments: [],
        modelId: TEST_MODEL.id,
        signal: AbortSignal.timeout(5_000),
      });
      expect(status).toBe("completed");
      expect(entered).toBe(2);
      expect(capturedRequests).toHaveLength(2);
      const step1ToolMsgs = capturedRequests[1]!.messages.filter((m) => m.role === "tool");
      expect(step1ToolMsgs).toHaveLength(2);
      // buildTurnContext 为每个 tool result 都配对前一条 assistant(toolCalls)
      const step1AssistantCalls = capturedRequests[1]!.messages.filter((m) => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0);
      expect(step1AssistantCalls).toHaveLength(2);
      expect(step1ToolMsgs.map((m) => m.toolCallId).sort()).toEqual(
        step1AssistantCalls.map((m) => m.toolCalls![0]!.id).sort(),
      );
      const combinedToolText = step1ToolMsgs.map((m) => m.content).join("\n");
      expect(combinedToolText).toContain("t_codex");
      expect(combinedToolText).toContain("t_claude-code");
    } finally {
      store.closeAll();
      home.cleanup();
    }
  });

  it("auto-approves sibling pending approvals when user allows with remember scope", async () => {
    const home = makeTempHome("sc-par-appr-");
    const store = new SessionStore({ paths: home.paths, logger });
    const session = store.get(store.create("ws1", "并行审批").sessionId);

    const registry = new ToolRegistry();
    const spec = BUILTIN_TOOLS["dispatch_task"];
    registry.register(spec, async (raw) => toolOk({ ok: true, agent: (raw as { agent_id: string }).agent_id }));

    const approvals = new ApprovalBroker(logger);
    const pipeline = new ToolPipeline({ registry, approvals, policy: () => "auto-read", logger });

    try {
      const p1 = pipeline.run({
        session,
        workspaceId: "ws1",
        workspacePath: home.home,
        mode: "write",
        name: "dispatch_task",
        args: { agent_id: "codex", instruction: "a", task_type: "implement", allow_write: true },
        signal: AbortSignal.timeout(5_000),
      });
      const p2 = pipeline.run({
        session,
        workspaceId: "ws1",
        workspacePath: home.home,
        mode: "write",
        name: "dispatch_task",
        args: { agent_id: "claude-code", instruction: "b", task_type: "implement", allow_write: true },
        signal: AbortSignal.timeout(5_000),
      });

      const deadline = Date.now() + 2000;
      while (approvals.pendingCallIds().length < 2 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const pending = approvals.pendingCallIds();
      expect(pending).toHaveLength(2);

      // 只审批第一个并记住本轮：第二个并发调用也应自动获批完成
      expect(approvals.respond(pending[0]!, "allow", "turn")).toBe(true);
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.outcome.status).toBe("ok");
      expect(r2.outcome.status).toBe("ok");
      expect(approvals.pendingCallIds()).toHaveLength(0);
    } finally {
      store.closeAll();
      home.cleanup();
    }
  });

  it("exposes parallel_write hint selectively only for worktree-isolated agents", async () => {
    const home = makeTempHome("sc-par-agents-");
    const store = new SessionStore({ paths: home.paths, logger });
    const session = store.get(store.create("ws1", "提示").sessionId);
    const registry = new ToolRegistry();

    registerBuiltinTools(registry, {
      listAgents: async () => [
        {
          id: "codex",
          label: "Codex",
          installed: true,
          level: 1,
          fragility: "official",
          compat: false,
          capabilities: { readOnly: true, resume: true, effort: true, streaming: true, receiptStates: ["queued"], fragility: "official" },
          checkedAt: new Date().toISOString(),
          sandbox: AgentSandboxProfileSchema.parse({ workspace: { isolation: "worktree" } }),
        },
        {
          id: "claude-code",
          label: "Claude Code",
          installed: true,
          level: 2,
          fragility: "documented",
          compat: true,
          capabilities: { readOnly: true, resume: true, effort: false, streaming: false, receiptStates: ["queued"], fragility: "documented" },
          checkedAt: new Date().toISOString(),
          sandbox: AgentSandboxProfileSchema.parse({ workspace: { isolation: "shared" } }),
        },
      ],
      dispatch: async () => { throw new Error("unused"); },
      task: () => null,
      listProviderSessions: async () => [],
      readProviderSession: async () => [],
      capsules: () => [],
      verificationCommand: () => "node -v",
      askUser: async () => null,
    });

    const pipeline = new ToolPipeline({ registry, approvals: new ApprovalBroker(logger), policy: () => "never", logger });
    try {
      const res = await pipeline.run({
        session,
        workspaceId: "ws1",
        workspacePath: home.home,
        mode: "read-only",
        name: "list_available_agents",
        args: {},
        signal: AbortSignal.timeout(5_000),
      });
      expect(res.outcome.status).toBe("ok");
      if (res.outcome.status === "ok") {
        const agents = (res.outcome.value as { agents: Array<Record<string, unknown>> }).agents;
        expect(agents[0]?.["parallel_write"]).toBe(true);
        expect("parallel_write" in (agents[1] ?? {})).toBe(false);
      }
    } finally {
      store.closeAll();
      home.cleanup();
    }
  });
});
