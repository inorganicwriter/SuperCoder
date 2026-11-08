/**
 * 八个核心内置工具功能集成验证。
 *
 * 走的是真 `registerBuiltinTools` + 真 `ToolPipeline` + 真 services 接线，
 * 只有外部 Agent 用假 provider 顶替（本机没装它们）。
 */

import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/host/boot/logger.js";
import { SessionStore } from "../../src/host/session/store.js";
import { ApprovalBroker } from "../../src/host/tools/approval.js";
import { ToolRegistry } from "../../src/host/tools/registry.js";
import { ToolPipeline } from "../../src/host/tools/pipeline.js";
import { latestNativeSession, registerBuiltinTools } from "../../src/host/tools/builtin/index.js";
import { QuestionBroker } from "../../src/host/agent/questions.js";
import { DelegationRunner } from "../../src/host/delegation/run.js";
import { ProviderSelect } from "../../src/host/delegation/provider-select.js";
import { WorkspaceLocks } from "../../src/host/workspace/locks.js";
import type { SessionEvent } from "../../src/shared/session/events.js";
import type { ToolOutcome } from "../../src/shared/domain/tool.js";
import type {
  DelegationEvent,
  DelegationResult,
} from "../../src/shared/domain/delegation.js";
import type {
  DelegationHandle,
  DelegationProvider,
  ProviderPage,
  ProviderSessionSummary,
  StoreProbe,
} from "../../src/shared/domain/provider.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

function fakeProvider(id: string, answer = "改好了"): DelegationProvider {
  return {
    id,
    capabilities: {
      readOnly: false,
      resume: false,
      effort: false,
      streaming: false,
      receiptStates: ["queued", "submitted", "returned"],
      fragility: "documented",
    },
    detect: async () => ({ installed: true }),
    listSessions: async (): Promise<ProviderSessionSummary[]> => [
      { sessionId: "sess-1", title: "历史会话", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    readSession: async (): Promise<DelegationEvent[]> => [{ type: "output", text: "历史内容" }],
    delegate: async (request): Promise<DelegationResult> => {
      request.onEvent({ type: "trace", summary: "delivery:queued" });
      request.onEvent({ type: "session", sessionId: request.resumeSessionId ?? "sess-1" });
      request.onEvent({ type: "trace", summary: "delivery:returned" });
      return { status: "ok", answer, durationMs: 1, sessionId: request.resumeSessionId ?? "sess-1" };
    },
    cancel: async (_handle: DelegationHandle) => undefined,
  };
}

function probe(): StoreProbe {
  return {
    providerId: "codex",
    locate: async () => null,
    listSessions: async (): Promise<ProviderSessionSummary[]> => [],
    readSession: async (): Promise<DelegationEvent[]> => [],
  };
}

function setup(answer?: string, checkAgentModel?: () => { status: "ok" } | { status: "error"; code: "invalid_args" | "denied"; message: string }) {
  const home = makeTempHome();
  const store = new SessionStore({ paths: home.paths, logger });
  const sessionId = store.create("ws1", "工具实测").sessionId;
  const session = store.get(sessionId);
  const select = new ProviderSelect([
    { id: "codex", label: "Codex", entries: [{ level: 1, provider: fakeProvider("codex", answer) }], probe: probe() },
  ]);
  const locks = new WorkspaceLocks();
  const runner = new DelegationRunner({ select, locks, logger });
  const questions = new QuestionBroker(logger);
  const registry = new ToolRegistry();
  const resumes: Array<string | undefined> = [];

  registerBuiltinTools(registry, {
    listAgents: () => select.statuses(),
    ...(checkAgentModel === undefined ? {} : { checkAgentModel }),
    dispatch: (input) => {
      resumes.push(input.resumeSessionId);
      return runner.dispatch({
        session: input.session,
        workspaceId: input.workspaceId,
        workspacePath: home.home,
        agentId: input.agentId,
        goal: input.goal,
        instruction: input.instruction,
        mode: input.mode,
        taskType: input.taskType,
        ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
        signal: input.signal,
      });
    },
    task: (id, taskId) => {
      const handle = store.maybe(id);
      return handle?.view().tasks.find((task) => task.taskId === taskId) ?? null;
    },
    listProviderSessions: (agentId, page: ProviderPage) => select.listSessions(agentId, "", page),
    readProviderSession: (agentId, id, page: ProviderPage) => select.readSession(agentId, id, page),
    capsules: (workspaceId, id) => store.capsules(workspaceId, id),
    verificationCommand: () => "node --version",
    askUser: (input) => questions.ask(input),
  });

  const pipeline = new ToolPipeline({
    registry,
    approvals: new ApprovalBroker(logger),
    policy: () => "never",
    logger,
  });

  const call = async (name: string, args: unknown): Promise<ToolOutcome> => {
    const result = await pipeline.run({
      session,
      workspaceId: "ws1",
      workspacePath: home.home,
      mode: "write",
      name,
      args,
      signal: AbortSignal.timeout(20_000),
    });
    return result.outcome;
  };

  return {
    session,
    questions,
    home,
    call,
    resumes,
    cleanup: () => {
      store.closeAll();
      home.cleanup();
    },
  };
}

function waitForEvent(
  session: { allEvents(): readonly SessionEvent[] },
  type: SessionEvent["type"],
  timeoutMs = 5_000,
): Promise<SessionEvent> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const found = session.allEvents().find((event) => event.type === type);
      if (found !== undefined) {
        resolve(found);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`等不到 ${type}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("Builtin Tools Collection", () => {
  it("list_available_agents", async () => {
    const fixture = setup();
    try {
      const outcome = await fixture.call("list_available_agents", {});
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") {
        const agents = (outcome.value as { agents: Array<Record<string, unknown>> }).agents;
        // 这个 fixture 只装了一个 family；真机上几家都可能出现。
        expect(agents.map((agent) => agent.id)).toEqual(["codex"]);
        // 给模型的是语义明确的字段：可任务分派、可写；不透传会被误读成"只读 / 兼容模式"的内部标志。
        // 只有名字、是否可用、模型：不透传接入级别和能力表，模型就不会复述出"只读 / 兼容模式"之类的标注。
        expect(Object.keys(agents[0]!).sort()).toEqual(["available", "id", "label"]);
        expect(agents[0]).toMatchObject({ available: true });
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects task dispatch upfront when model profile is invalid", async () => {
    const fixture = setup("改好了", () => ({
      status: "error",
      code: "invalid_args",
      message: "所选模型档案已删除（deepseek），请在 Agent 面板重新选择可用模型。",
    }));
    try {
      const outcome = await fixture.call("dispatch_task", {
        agent_id: "codex",
        instruction: "把按钮文案改成中文",
        task_type: "implement",
        allow_write: true,
      });
      // 配置错误是 invalid_args，不是 uncertain：什么都没跑，不存在需要核对的副作用。
      expect(outcome.status).toBe("error");
      if (outcome.status === "error") {
        expect(outcome.code).toBe("invalid_args");
        expect(outcome.message).toContain("已删除");
        expect(outcome.retryable).toBe(false);
      }
      // 没有进入执行体：既没任务分派，也没写 spawn 事件。
      expect(fixture.resumes).toEqual([]);
      expect(fixture.session.allEvents().map((event) => event.type)).not.toContain("delegation/spawn");
    } finally {
      fixture.cleanup();
    }
  });

  it("dispatch_task → query_task_status", async () => {
    const fixture = setup();
    try {
      const dispatched = await fixture.call("dispatch_task", {
        agent_id: "codex",
        instruction: "把按钮文案改成中文",
        task_type: "implement",
        allow_write: true,
      });
      expect(dispatched.status).toBe("ok");
      const taskId =
        dispatched.status === "ok" ? (dispatched.value as { task_id: string }).task_id : "";
      expect(taskId).not.toBe("");

      // 任务分派把三种事件都写进了日志。
      const types = fixture.session.allEvents().map((event) => event.type);
      expect(types).toContain("delegation/spawn");
      expect(types).toContain("delegation/result");

      const status = await fixture.call("query_task_status", { task_id: taskId });
      expect(status.status).toBe("ok");
      if (status.status === "ok") {
        expect((status.value as { state: string }).state).toBe("returned");
      }

      // Review tasks respect the explicitly requested write permission.
      const review = await fixture.call("dispatch_task", {
        agent_id: "codex",
        instruction: "审一下这个改动",
        task_type: "review",
        allow_write: true,
      });
      expect(review.status).toBe("ok");
      const spawn = fixture.session
        .allEvents()
        .filter((event) => event.type === "delegation/spawn")
        .at(-1) as { mode?: string } | undefined;
      expect(spawn?.mode).toBe("write");
      await fixture.call("dispatch_task", {
        agent_id: "codex",
        instruction: "只读审查",
        task_type: "review",
        allow_write: false,
      });
      const readonlySpawn = fixture.session.allEvents().filter((event) => event.type === "delegation/spawn").at(-1) as { mode?: string } | undefined;
      expect(readonlySpawn?.mode).toBe("read-only");
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves the user's exact message separately from a staged agent assignment", async () => {
    const fixture = setup();
    try {
      const original = "继续推进\n请先交给 OpenCode，再让 DSH 核实。";
      const assignment = "复核 OpenCode 的结果：文件 a.ts 第 12 行有空值风险。请核对并给出改法。";
      fixture.session.append("user/message", { text: original, attachments: [] });
      const result = await fixture.call("dispatch_task", { agent_id: "codex", instruction: assignment, task_type: "review", allow_write: true });
      expect(result.status).toBe("ok");
      const spawn = fixture.session.allEvents().findLast((event) => event.type === "delegation/spawn");
      expect(spawn).toMatchObject({ goal: original, instruction: assignment, mode: "write" });
      expect(fixture.session.view().tasks.at(-1)?.taskType).toBe("review");
    } finally { fixture.cleanup(); }
  });

  it("continues the same agent session by default and starts fresh only on request", async () => {
    const fixture = setup();
    try {
      fixture.session.append("user/message", { text: "先分析，再改", attachments: [] });
      const first = await fixture.call("dispatch_task", { agent_id: "codex", instruction: "分析", task_type: "review", allow_write: true });
      if (first.status !== "ok") throw new Error("first stage failed");
      const firstId = (first.value as { task_id: string }).task_id;
      // 第二次派给同一个 Agent：自动续上第一次的原生会话。
      const second = await fixture.call("dispatch_task", { agent_id: "codex", instruction: "按分析修改", task_type: "fix", allow_write: true, context_task_ids: [firstId] });
      expect(second.status).toBe("ok");
      expect(fixture.resumes).toEqual([undefined, "sess-1"]);
      if (second.status === "ok") expect(second.value).toMatchObject({ continued_session: true, session_id: "sess-1" });
      // 同一个原生会话里完成的上游结果不重复附带。
      const spawn = fixture.session.allEvents().findLast((event) => event.type === "delegation/spawn");
      expect(spawn?.type === "delegation/spawn" ? spawn.instruction : "").not.toContain("Previous result");
      // 明确要求新开：不续话。
      await fixture.call("dispatch_task", { agent_id: "codex", instruction: "另起一件事", task_type: "general", allow_write: true, new_session: true });
      expect(fixture.resumes.at(-1)).toBeUndefined();
    } finally { fixture.cleanup(); }
  });

  it("picks the latest successful native session of the same agent only", () => {
    const base = { childId: "", providerId: "p", goal: "", instruction: "", mode: "write" as const, state: "returned" as const, receipt: null, retryCount: 0, createdAt: "", updatedAt: "" };
    const ok = { status: "ok" as const, answer: "a", durationMs: 1 };
    const tasks = [
      { ...base, taskId: "1", agentId: "codex", nativeSessionId: "old", result: ok, seq: 1 },
      { ...base, taskId: "2", agentId: "opencode", nativeSessionId: "other", result: ok, seq: 5 },
      { ...base, taskId: "3", agentId: "codex", nativeSessionId: "new", result: ok, seq: 9 },
      { ...base, taskId: "4", agentId: "codex", nativeSessionId: "broken", result: { status: "failed" as const, diagnostic: { stage: "turn" as const, category: "unknown" as const }, durationMs: 1 }, seq: 12 },
    ];
    expect(latestNativeSession(tasks, "codex")).toBe("new");
    expect(latestNativeSession(tasks, "opencode")).toBe("other");
    expect(latestNativeSession(tasks, "kimi-code")).toBeUndefined();
  });

  it("attaches successful earlier answers to the next agent and rejects unknown task IDs", async () => {
    const fixture = setup();
    try {
      fixture.session.append("user/message", { text: "先分析再给方案", attachments: [] });
      const first = await fixture.call("dispatch_task", { agent_id: "codex", instruction: "分析项目", task_type: "review", allow_write: true });
      expect(first.status).toBe("ok");
      if (first.status !== "ok") return;
      const id = (first.value as { task_id: string }).task_id;
      const second = await fixture.call("dispatch_task", { agent_id: "codex", instruction: "根据前序分析提出方案", task_type: "plan", allow_write: true, new_session: true, context_task_ids: [id] });
      expect(second.status).toBe("ok");
      const spawn = fixture.session.allEvents().findLast((event) => event.type === "delegation/spawn");
      expect(spawn?.type === "delegation/spawn" ? spawn.instruction : "").toContain("Previous result (codex):\n改好了");
      const before = fixture.session.view().tasks.length;
      const missing = await fixture.call("dispatch_task", { agent_id: "codex", instruction: "复核", task_type: "review", allow_write: true, context_task_ids: ["missing"] });
      expect(missing.status).toBe("error");
      expect(fixture.session.view().tasks).toHaveLength(before);
    } finally { fixture.cleanup(); }
  });

  it("preserves the end of a long previous answer in the next assignment", async () => {
    const answer = `${"上游发现。".repeat(2500)}END_OF_PREVIOUS_RESULT`;
    const fixture = setup(answer);
    try {
      fixture.session.append("user/message", { text: "先分析，再提出建议", attachments: [] });
      const first = await fixture.call("dispatch_task", { agent_id: "codex", instruction: "分析", task_type: "review", allow_write: true });
      if (first.status !== "ok") throw new Error("first stage failed");
      const id = (first.value as { task_id: string }).task_id;
      const second = await fixture.call("dispatch_task", { agent_id: "codex", instruction: "根据前序结果给建议", task_type: "plan", allow_write: true, new_session: true, context_task_ids: [id] });
      expect(second.status).toBe("ok");
      const spawn = fixture.session.allEvents().findLast((event) => event.type === "delegation/spawn");
      expect(spawn?.type === "delegation/spawn" ? spawn.instruction : "").toContain(answer);
    } finally { fixture.cleanup(); }
  });

  it("does not duplicate a previous result already present in the assignment", async () => {
    const fixture = setup();
    try {
      fixture.session.append("user/message", { text: "先分析，再给出建议", attachments: [] });
      const first = await fixture.call("dispatch_task", { agent_id: "codex", instruction: "分析", task_type: "review", allow_write: true });
      if (first.status !== "ok") throw new Error("first stage failed");
      const id = (first.value as { task_id: string }).task_id;
      const instruction = "上游结果：改好了。请复核。";
      await fixture.call("dispatch_task", { agent_id: "codex", instruction, task_type: "review", allow_write: true, new_session: true, context_task_ids: [id] });
      const spawn = fixture.session.allEvents().findLast((event) => event.type === "delegation/spawn");
      expect(spawn?.type === "delegation/spawn" ? spawn.instruction : "").toBe(instruction);
    } finally { fixture.cleanup(); }
  });

  it("list_agent_sessions / read_agent_session", async () => {
    const fixture = setup();
    try {
      const list = await fixture.call("list_agent_sessions", {
        agent_id: "codex",
        offset: 0,
        limit: 10,
      });
      expect(list.status).toBe("ok");
      if (list.status === "ok") {
        const sessions = (list.value as { sessions: Array<{ sessionId: string }> }).sessions;
        expect(sessions[0]?.sessionId).toBe("sess-1");
      }

      const read = await fixture.call("read_agent_session", {
        agent_id: "codex",
        session_id: "sess-1",
        offset: 0,
        limit: 10,
      });
      expect(read.status).toBe("ok");
      if (read.status === "ok") {
        const events = (read.value as { events: Array<{ type: string; text?: string }> }).events;
        expect(events[0]?.type).toBe("output");
        expect(events[0]?.text).toBe("历史内容");
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("manage_context_capsule：create → list → update", async () => {
    const fixture = setup();
    try {
      const created = await fixture.call("manage_context_capsule", {
        action: "create",
        title: "登录页改造",
        human_summary: "把登录页文案改成中文",
        technical_handoff: "改了 src/login.tsx 的三个字符串",
        touched_files: ["src/login.tsx"],
        scope: "chat",
      });
      expect(created.status).toBe("ok");

      const listed = await fixture.call("manage_context_capsule", {
        action: "list",
        scope: "chat",
      });
      expect(listed.status).toBe("ok");
      if (listed.status === "ok") {
        const capsules = (listed.value as { capsules: Array<{ title: string; capsuleId: string }> })
          .capsules;
        expect(capsules.map((capsule) => capsule.title)).toContain("登录页改造");
      }
      expect(fixture.session.allEvents().map((event) => event.type)).toContain("capsule/saved");
    } finally {
      fixture.cleanup();
    }
  });

  it("run_workspace_verification: executes verification command in workspace", async () => {
    const fixture = setup();
    try {
      const outcome = await fixture.call("run_workspace_verification", {});
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") {
        const result = outcome.value as {
          command: string;
          exit_code: number | null;
          stdout: string;
          duration_ms: number;
        };
        expect(result.command).toBe("node --version");
        expect(result.exit_code).toBe(0);
        expect(result.stdout.trim()).toMatch(/^v\d+\./);
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("run_workspace_verification: rejects shell metacharacters", async () => {
    const fixture = setup();
    try {
      const outcome = await fixture.call("run_workspace_verification", {
        custom_cmd: "echo hi && whoami",
      });
      // 元字符在拆命令时就拒了，归到"参数不合规"（不会落到 shell）。
      expect(outcome.status).toBe("error");
      if (outcome.status === "error") {
        expect(outcome.code).toBe("invalid_args");
        expect(outcome.message).toContain("shell 元字符");
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("ask_user_decision: suspends execution until user answers", async () => {
    const fixture = setup();
    try {
      const pending = fixture.call("ask_user_decision", {
        question: "要覆盖已有文件吗？",
        options: ["覆盖", "跳过"],
      });
      const asked = await waitForEvent(fixture.session, "question/asked");
      const questionId = (asked as { questionId: string }).questionId;
      expect(fixture.questions.answer(questionId, "跳过")).toBe(true);
      const outcome = await pending;
      expect(outcome.status).toBe("ok");
      if (outcome.status === "ok") {
        expect((outcome.value as { answer: string }).answer).toBe("跳过");
      }
      expect(fixture.session.allEvents().map((event) => event.type)).toContain("question/answered");
    } finally {
      fixture.cleanup();
    }
  });
});
