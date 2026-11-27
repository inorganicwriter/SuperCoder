/**
 * 外部 Agent 担任 Superagent 的完整链路验证：
 * - SuperagentMcpBridge 鉴权、列出 8 个内置工具、通过 ToolPipeline 执行工具、防递归自派发、dispose 后失效
 * - 无任何 API 模型档案时通过 AgentHub + ExternalTurnRunner 完成对话、透传流式增量、多轮续话、rewind 后自动开新会话
 * - Claude Code 与 ACP Provider 对 superagentMcp 端点的注入行为
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../../src/host/boot/config.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createTestBackend, SecretStore } from "../../src/host/boot/secrets.js";
import { ExternalTurnRunner } from "../../src/host/agent/external-turn.js";
import { AgentHub } from "../../src/host/agent/hub.js";
import { QuestionBroker } from "../../src/host/agent/questions.js";
import { SuperagentMcpBridge } from "../../src/host/agent/superagent-mcp.js";
import { SuperagentPreferences } from "../../src/host/agent/superagent-preferences.js";
import { AgentNetworkProxy } from "../../src/host/delegation/network-proxy.js";
import { ProviderSelect } from "../../src/host/delegation/provider-select.js";
import { AcpProvider } from "../../src/host/delegation/providers/acp.js";
import { ClaudeCodeProvider } from "../../src/host/delegation/providers/claude-code.js";
import { AgentSandboxPreferences } from "../../src/host/delegation/sandbox-preferences.js";
import type { JsonRpcTransport, RpcNotification } from "../../src/host/delegation/transport.js";
import { ModelCatalog } from "../../src/host/models/catalog.js";
import { SessionStore } from "../../src/host/session/store.js";
import { ApprovalBroker } from "../../src/host/tools/approval.js";
import { registerBuiltinTools } from "../../src/host/tools/builtin/index.js";
import { ToolPipeline } from "../../src/host/tools/pipeline.js";
import { ToolRegistry } from "../../src/host/tools/registry.js";
import type { DelegationRequest, DelegationResult } from "../../src/shared/domain/delegation.js";
import type { DelegationProvider, ProviderCapabilities } from "../../src/shared/domain/provider.js";
import { makeTempHome } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn().catch(() => undefined);
  }
});

const STUB_CAPS: ProviderCapabilities = {
  readOnly: true,
  resume: true,
  effort: false,
  streaming: true,
  receiptStates: ["queued", "submitted", "received", "returned"],
  fragility: "official",
};

describe("External Agent as Superagent", () => {
  it("exposes builtin tools via SuperagentMcpBridge, blocks recursive self-dispatch, and invalidates tokens on dispose", async () => {
    const temp = makeTempHome("sc-superagent-mcp-");
    cleanups.push(async () => temp.cleanup());
    const logger = silentLogger();
    const sessions = new SessionStore({ paths: temp.paths, logger });
    const { sessionId } = sessions.create("ws1");
    const session = sessions.get(sessionId);

    const registry = new ToolRegistry();
    const approvals = new ApprovalBroker(logger);
    const pipeline = new ToolPipeline({ registry, approvals, policy: () => "never", logger });
    const dispatchedTargets: string[] = [];

    registerBuiltinTools(registry, {
      listAgents: async () => [
        {
          id: "codex",
          label: "Codex",
          installed: true,
          level: 1,
          fragility: "official",
          compat: false,
          capabilities: STUB_CAPS,
          checkedAt: new Date().toISOString(),
        },
      ],
      dispatch: async (input) => {
        dispatchedTargets.push(input.agentId);
        return {
          taskId: "task_sub_1",
          childId: "task_sub_1",
          providerId: input.agentId,
          agentId: input.agentId,
          goal: input.goal,
          instruction: input.instruction,
          mode: input.mode,
          state: "returned",
          receipt: "returned",
          result: { status: "ok", answer: "subagent done", durationMs: 5 },
          retryCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
      task: () => null,
      listProviderSessions: async () => [],
      readProviderSession: async () => [],
      capsules: () => [],
      verificationCommand: () => "git status --porcelain",
      askUser: async () => "ok",
    });

    const bridge = new SuperagentMcpBridge({ registry, pipeline, logger });
    await bridge.start();
    cleanups.push(() => bridge.close());

    const controller = new AbortController();
    const scope = bridge.registerTurn({
      session,
      workspacePath: temp.home,
      superagentId: "claude-code",
      signal: controller.signal,
      onUncertain: () => undefined,
    });

    // 无令牌拒绝访问
    const unauth = await fetch(scope.endpoint.url, { method: "POST", body: "{}" });
    expect(unauth.status).toBe(401);

    const client = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(scope.endpoint.url), {
      requestInit: { headers: { authorization: `Bearer ${scope.endpoint.bearerToken}` } },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(8);
      expect(tools.tools.map((item) => item.name)).toContain("dispatch_task");

      const agentsRes = await client.callTool({ name: "list_available_agents", arguments: {} });
      expect(agentsRes.isError).not.toBe(true);

      // 递归派发给自己必须被拒绝
      const selfDispatch = await client.callTool({
        name: "dispatch_task",
        arguments: {
          agent_id: "claude-code",
          instruction: "recurse",
          task_type: "general",
          allow_write: false,
        },
      });
      expect(selfDispatch.isError).toBe(true);
      expect(JSON.stringify(selfDispatch.content)).toContain("禁止递归自派发");

      // 派发给其他 Agent 正常通过 ToolPipeline
      const peerDispatch = await client.callTool({
        name: "dispatch_task",
        arguments: {
          agent_id: "codex",
          instruction: "help inspect file",
          task_type: "general",
          allow_write: false,
        },
      });
      expect(peerDispatch.isError).not.toBe(true);
      expect(dispatchedTargets).toEqual(["codex"]);
    } finally {
      await client.close();
      sessions.closeAll();
    }

    // dispose 后令牌立即失效
    scope.dispose();
    const afterDispose = await fetch(scope.endpoint.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${scope.endpoint.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(afterDispose.status).toBe(401);
  });

  it("drives main turns via external Superagent without any API model, resumes session, and drops stale thread after rewind", async () => {
    const temp = makeTempHome("sc-superagent-turn-");
    cleanups.push(async () => temp.cleanup());
    const logger = silentLogger();
    const sessions = new SessionStore({ paths: temp.paths, logger });
    const { sessionId } = sessions.create("ws1");
    const session = sessions.get(sessionId);

    const settings = new SettingsStore(temp.paths);
    const secrets = new SecretStore(temp.paths.secretsFile, createTestBackend());
    const models = new ModelCatalog({ settings, secrets });
    expect(models.defaultModelId).toBeNull();

    const receivedRequests: DelegationRequest[] = [];
    let counter = 0;
    const stubProvider: DelegationProvider = {
      id: "stub-super",
      capabilities: STUB_CAPS,
      supportsSandbox: { env: true, network: true, worktree: true },
      detect: async () => ({ installed: true, binaryPath: "/bin/stub" }),
      listSessions: async () => [],
      readSession: async () => [],
      delegate: async (request): Promise<DelegationResult> => {
        receivedRequests.push(request);
        counter += 1;
        request.onEvent({ type: "session", sessionId: `native-thread-${counter}` });
        request.onEvent({ type: "output", text: "思考中" });
        return {
          status: "ok",
          answer: `第 ${counter} 轮回答`,
          sessionId: `native-thread-${counter}`,
          durationMs: 10,
        };
      },
      cancel: async () => undefined,
    };

    const select = new ProviderSelect([
      {
        id: "stub-super",
        label: "Stub Super",
        entries: [{ level: 1, provider: stubProvider }],
        probe: {
          providerId: "stub-super",
          locate: async () => null,
          listSessions: async () => [],
          readSession: async () => [],
        },
      },
    ]);
    const sandboxes = new AgentSandboxPreferences({
      file: join(temp.home, "agent-sandboxes.json"),
      secrets,
      sandboxesDir: temp.paths.sandboxesDir,
    });
    const proxy = new AgentNetworkProxy();
    cleanups.push(() => proxy.close());

    const registry = new ToolRegistry();
    const approvals = new ApprovalBroker(logger);
    const pipeline = new ToolPipeline({ registry, approvals, policy: () => "never", logger });
    registerBuiltinTools(registry, {
      listAgents: async () => [],
      dispatch: async () => {
        throw new Error("unused");
      },
      task: () => null,
      listProviderSessions: async () => [],
      readProviderSession: async () => [],
      capsules: () => [],
      verificationCommand: () => "git status --porcelain",
      askUser: async () => null,
    });

    const superagentPrefs = new SuperagentPreferences(temp.home);
    superagentPrefs.set({ kind: "agent", agentId: "stub-super" });
    const superagentMcp = new SuperagentMcpBridge({ registry, pipeline, logger });
    cleanups.push(() => superagentMcp.close());

    const externalRunner = new ExternalTurnRunner({
      select,
      sandboxes,
      networkProxy: proxy,
      superagentPrefs,
      superagentMcp,
      registry,
      approvals,
      logger,
      language: () => "zh-CN",
      workspacePath: () => temp.home,
    });
    const hub = new AgentHub({
      models,
      tools: pipeline,
      registry,
      approvals,
      questions: new QuestionBroker(logger),
      logger,
      language: () => "zh-CN",
      workspacePathOf: () => temp.home,
      superagent: () => superagentPrefs.get(),
      validateSuperagentAgent: (agentId) => {
        select.family(agentId);
      },
      externalRunner,
    });

    const deltas: string[] = [];
    const unsubscribe = session.subscribe((events) => {
      for (const ev of events) {
        if (ev.type === "request/delta") deltas.push(ev.text);
      }
    });
    cleanups.push(async () => {
      unsubscribe();
      sessions.closeAll();
    });

    // 第一轮：无模型档案，完整发消息并注入 superagentMcp，同时落盘工作区快照供 rewind 使用
    const turn1 = hub.send({ session, text: "先分析工作区", attachments: [] });
    expect(await hub.waitTurn(turn1.turnId)).toBe("completed");
    expect(deltas).toContain("思考中");
    expect(receivedRequests[0]?.resumeSessionId).toBeUndefined();
    expect(receivedRequests[0]?.superagentMcp?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(receivedRequests[0]?.superagentMcp?.bearerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(session.allEvents().some((ev) => ev.type === "snapshot/taken" && ev.taskId === turn1.turnId)).toBe(true);
    expect(session.view().messages.map((m) => m.text)).toEqual(["先分析工作区", "第 1 轮回答"]);

    // 第二轮：自动续用第一轮的原生会话 ID
    const turn2 = hub.send({ session, text: "继续完善测试", attachments: [] });
    expect(await hub.waitTurn(turn2.turnId)).toBe("completed");
    expect(receivedRequests[1]?.resumeSessionId).toBe("native-thread-1");
    expect(receivedRequests[1]?.instruction).toBe("");

    // 倒带到第 1 条用户消息处（抹除助手回复之后的内容）：应清空旧绑定并开启新会话
    const firstUserSeq = session.view().messages[0]!.seq;
    session.append("user/rewind", { toSeq: firstUserSeq });
    const turn3 = hub.send({ session, text: "重新开始一个方案", attachments: [] });
    expect(await hub.waitTurn(turn3.turnId)).toBe("completed");
    expect(receivedRequests[2]?.resumeSessionId).toBeUndefined();
  });

  it("injects ephemeral MCP config into ClaudeCodeProvider and mcpServers into AcpProvider", async () => {
    let seenArgs: readonly string[] = [];
    let seenConfigText = "";
    let seenConfigPath = "";

    const claude = new ClaudeCodeProvider({
      run: async (args) => {
        seenArgs = args;
        const idx = args.indexOf("--mcp-config");
        seenConfigPath = idx >= 0 ? (args[idx + 1] ?? "") : "";
        seenConfigText = seenConfigPath !== "" ? readFileSync(seenConfigPath, "utf8") : "";
        return {
          code: 0,
          signal: null,
          durationMs: 5,
          aborted: false,
          stdout: JSON.stringify({ type: "result", result: "ok", session_id: "c1" }),
          stderr: "",
          overflowed: false,
          timedOut: false,
        };
      },
    });
    const claudeRes = await claude.delegate({
      childId: "t1",
      agentId: "claude-code",
      workspace: process.cwd(),
      goal: "hi",
      instruction: "",
      mode: "write",
      superagentMcp: { name: "supercoder", url: "http://127.0.0.1:4321/mcp", bearerToken: "tok-secret" },
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(claudeRes.status).toBe("ok");
    expect(seenArgs).toContain("--allowedTools");
    expect(seenArgs).toContain("mcp__supercoder__*");
    expect(JSON.parse(seenConfigText)).toEqual({
      mcpServers: {
        supercoder: {
          type: "http",
          url: "http://127.0.0.1:4321/mcp",
          headers: { Authorization: "Bearer tok-secret" },
        },
      },
    });
    expect(existsSync(seenConfigPath)).toBe(false);

    let sentNewParams: unknown = null;
    const acp = new AcpProvider({
      drainMs: 0,
      createTransport: (): JsonRpcTransport => {
        const notificationListeners = new Set<(n: RpcNotification) => void>();
        return {
          request: async (method, params) => {
            if (method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
            if (method === "session/new") {
              sentNewParams = params;
              return { sessionId: "acp-1" };
            }
            if (method === "session/prompt") {
              for (const fn of notificationListeners) {
                fn({
                  method: "session/update",
                  params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { text: "acp ok" } } },
                });
              }
              return { stopReason: "end_turn" };
            }
            return {};
          },
          notify: () => undefined,
          onNotification: (listener) => {
            notificationListeners.add(listener);
            return () => notificationListeners.delete(listener);
          },
          onExit: () => () => undefined,
          close: () => undefined,
        };
      },
    });
    const acpRes = await acp.delegate({
      childId: "t2",
      agentId: "opencode",
      workspace: process.cwd(),
      goal: "hi",
      instruction: "",
      mode: "write",
      superagentMcp: { name: "supercoder", url: "http://127.0.0.1:4321/mcp", bearerToken: "tok-acp" },
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(acpRes.status).toBe("ok");
    expect(sentNewParams).toMatchObject({
      mcpServers: [
        {
          type: "http",
          name: "supercoder",
          url: "http://127.0.0.1:4321/mcp",
          headers: [{ name: "Authorization", value: "Bearer tok-acp" }],
        },
      ],
    });
  });
});
