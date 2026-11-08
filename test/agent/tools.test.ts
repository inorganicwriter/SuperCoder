/**
 * 工具注册、权限审批流程、未知副作用处理与提问交互测试。
 * 内置工具安全调用规范测试。
 */

import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/shared/session/events.js";
import { BUILTIN_TOOLS } from "../../src/shared/domain/builtin-tools.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { SessionStore } from "../../src/host/session/store.js";
import { ApprovalBroker } from "../../src/host/tools/approval.js";
import { ToolRegistry } from "../../src/host/tools/registry.js";
import { ToolPipeline } from "../../src/host/tools/pipeline.js";
import { registerBuiltinTools, splitCommand } from "../../src/host/tools/builtin/index.js";
import { QuestionBroker } from "../../src/host/agent/questions.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

function setup(options: { policy?: "ask" | "auto-read" | "never"; timeoutMs?: number } = {}) {
  const home = makeTempHome();
  const store = new SessionStore({ paths: home.paths, logger });
  const sessionId = store.create("ws1", "工具测试").sessionId;
  const session = store.get(sessionId);
  const registry = new ToolRegistry();
  const approvals = new ApprovalBroker(logger);
  const pipeline = new ToolPipeline({
    registry,
    approvals,
    policy: () => options.policy ?? "ask",
    logger,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return {
    home,
    store,
    session,
    registry,
    approvals,
    pipeline,
    cleanup: () => {
      store.closeAll();
      home.cleanup();
    },
  };
}

async function waitForEvent(
  session: { allEvents(): readonly SessionEvent[] },
  type: SessionEvent["type"],
  timeoutMs = 2000,
): Promise<SessionEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = session.allEvents().find((event) => event.type === type);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等不到 ${type}`);
}

describe("Tool Registry", () => {
  it("registers all builtin tools and exports valid parameter schemas", () => {
    const fixture = setup();
    try {
      const noop = async (): Promise<never> => {
        throw new Error("不该被调用");
      };
      registerBuiltinTools(fixture.registry, {
        listAgents: async () => [],
        dispatch: async () => {
          throw new Error("不该被调用");
        },
        task: () => null,
        listProviderSessions: async () => [],
        readProviderSession: async () => [],
        capsules: () => [],
        verificationCommand: () => "git status --porcelain",
        askUser: async () => null,
      });
      void noop;
      expect(fixture.registry.builtinNames().sort()).toEqual(
        Object.keys(BUILTIN_TOOLS).sort(),
      );
      const specs = fixture.registry.specs();
      expect(specs).toHaveLength(8);
      for (const spec of specs) {
        expect(spec.parameters["type"]).toBe("object");
      }
    } finally {
      fixture.cleanup();
    }
  });
});

describe("Tool Pipeline", () => {
  it("logs tool/call before rejecting unknown tools with unknown_tool", async () => {
    const fixture = setup();
    try {
      const result = await fixture.pipeline.run({
        session: fixture.session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        mode: "write",
        name: "no_such_tool",
        args: {},
        signal: new AbortController().signal,
      });
      expect(result.outcome.status).toBe("error");
      if (result.outcome.status === "error") expect(result.outcome.code).toBe("unknown_tool");
      const types = fixture.session.allEvents().map((event) => event.type);
      expect(types).toEqual(["tool/call", "tool/result"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("returns invalid_args without side effects on invalid parameters (retryable)", async () => {
    const fixture = setup();
    try {
      fixture.registry.register(BUILTIN_TOOLS.query_task_status, async () => ({
        status: "ok",
        value: null,
      }));
      const result = await fixture.pipeline.run({
        session: fixture.session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        mode: "write",
        name: "query_task_status",
        args: { task_id: 42 },
        signal: new AbortController().signal,
      });
      expect(result.outcome.status).toBe("error");
      if (result.outcome.status === "error") {
        expect(result.outcome.code).toBe("invalid_args");
        expect(result.outcome.retryable).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("denies mutating tool calls from read-only tasks without user prompt", async () => {
    const fixture = setup();
    try {
      const executed: string[] = [];
      fixture.registry.register(BUILTIN_TOOLS.dispatch_task, async () => {
        executed.push("dispatch");
        return { status: "ok", value: {} };
      });
      const result = await fixture.pipeline.run({
        session: fixture.session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        mode: "read-only",
        name: "dispatch_task",
        args: { agent_id: "codex", task_type: "general", instruction: "随便做点什么", allow_write: true },
        signal: new AbortController().signal,
      });
      expect(result.outcome.status).toBe("error");
      if (result.outcome.status === "error") expect(result.outcome.code).toBe("denied");
      expect(executed).toHaveLength(0);
      expect(fixture.approvals.waiting).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  it("denies execution and emits tool/decision(deny) when user denies approval", async () => {
    const fixture = setup();
    try {
      let executed = false;
      fixture.registry.register(BUILTIN_TOOLS.dispatch_task, async () => {
        executed = true;
        return { status: "ok", value: {} };
      });
      const run = fixture.pipeline.run({
        session: fixture.session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        mode: "write",
        name: "dispatch_task",
        args: { agent_id: "codex", task_type: "general", instruction: "写点东西", allow_write: true },
        signal: new AbortController().signal,
      });
      const requested = await waitForEvent(fixture.session, "tool/approval-requested");
      const callId = (requested as { callId: string }).callId;
      expect(fixture.approvals.respond(callId, "deny", "none")).toBe(true);
      const result = await run;
      expect(result.outcome.status).toBe("error");
      if (result.outcome.status === "error") expect(result.outcome.code).toBe("denied");
      expect(executed).toBe(false);
      const decision = fixture.session.allEvents().find((event) => event.type === "tool/decision");
      expect(decision).toBeDefined();
      if (decision?.type === "tool/decision") expect(decision.decision).toBe("deny");
    } finally {
      fixture.cleanup();
    }
  });

  it("remembers turn approval so subsequent calls to same tool skip prompt", async () => {
    const fixture = setup();
    try {
      let runs = 0;
      fixture.registry.register(BUILTIN_TOOLS.dispatch_task, async () => {
        runs += 1;
        return { status: "ok", value: { run: runs } };
      });
      const first = fixture.pipeline.run({
        session: fixture.session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        mode: "write",
        name: "dispatch_task",
        args: { agent_id: "codex", task_type: "general", instruction: "一", allow_write: true },
        signal: new AbortController().signal,
      });
      const requested = await waitForEvent(fixture.session, "tool/approval-requested");
      fixture.approvals.respond((requested as { callId: string }).callId, "allow", "turn");
      expect((await first).outcome.status).toBe("ok");

      const second = await fixture.pipeline.run({
        session: fixture.session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        mode: "write",
        name: "dispatch_task",
        args: { agent_id: "codex", task_type: "general", instruction: "二", allow_write: true },
        signal: new AbortController().signal,
      });
      expect(second.outcome.status).toBe("ok");
      expect(runs).toBe(2);
      expect(
        fixture.session.allEvents().filter((event) => event.type === "tool/approval-requested"),
      ).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("marks execution as uncertain on timeout", async () => {
    const fixture = setup({ timeoutMs: 20, policy: "never" });
    try {
      fixture.registry.register(BUILTIN_TOOLS.run_workspace_verification, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { status: "ok", value: { done: true } };
      });
      const result = await fixture.pipeline.run({
        session: fixture.session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        mode: "write",
        name: "run_workspace_verification",
        args: {},
        signal: new AbortController().signal,
      });
      expect(result.outcome.status).toBe("uncertain");
    } finally {
      fixture.cleanup();
    }
  });

  it("marks interrupted execution as uncertain", async () => {
    const fixture = setup({ policy: "never" });
    try {
      const controller = new AbortController();
      fixture.registry.register(BUILTIN_TOOLS.run_workspace_verification, async (_args, ctx) => {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 500);
          ctx.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve(null);
          });
        });
        return {
          status: "error",
          code: "failed",
          message: "被中断",
          retryable: true,
        };
      });
      const run = fixture.pipeline.run({
        session: fixture.session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        mode: "write",
        name: "run_workspace_verification",
        args: {},
        signal: controller.signal,
      });
      await waitForEvent(fixture.session, "tool/call");
      controller.abort();
      expect((await run).outcome.status).toBe("uncertain");
    } finally {
      fixture.cleanup();
    }
  });

  it("fails explicitly when result exceeds size limits without returning truncated payload", async () => {
    const fixture = setup({ policy: "never" });
    try {
      fixture.registry.register(BUILTIN_TOOLS.read_agent_session, async () => ({
        status: "ok",
        value: { blob: "x".repeat(1_000_001) },
      }));
      const result = await fixture.pipeline.run({
        session: fixture.session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        mode: "write",
        name: "read_agent_session",
        args: { agent_id: "codex", session_id: "s", offset: 0, limit: 10 },
        signal: new AbortController().signal,
      });
      expect(result.outcome.status).toBe("error");
      if (result.outcome.status === "error") {
        expect(result.outcome.code).toBe("failed");
        expect(result.outcome.message).toContain("过大");
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("never prompts user under 'never' approval policy", async () => {
    const fixture = setup({ policy: "never" });
    try {
      fixture.registry.register(BUILTIN_TOOLS.dispatch_task, async () => ({
        status: "ok",
        value: {},
      }));
      const result = await fixture.pipeline.run({
        session: fixture.session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        mode: "write",
        name: "dispatch_task",
        args: { agent_id: "codex", task_type: "general", instruction: "x", allow_write: true },
        signal: new AbortController().signal,
      });
      expect(result.outcome.status).toBe("ok");
      expect(
        fixture.session.allEvents().filter((event) => event.type === "tool/approval-requested"),
      ).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("User Decision Questions (ask_user_decision)", () => {
  it("logs question, logs answer, and resolves tool execution with answer", async () => {
    const home = makeTempHome();
    const store = new SessionStore({ paths: home.paths, logger });
    const session = store.get(store.create("ws1", "提问测试").sessionId);
    try {
      const questions = new QuestionBroker(logger);
      const pending = questions.ask({
        session,
        question: "要备份吗？",
        options: ["要", "不要"],
        signal: new AbortController().signal,
      });
      const asked = await waitForEvent(session, "question/asked");
      const questionId = (asked as { questionId: string }).questionId;
      expect(questions.pendingIds()).toEqual([questionId]);
      expect(questions.answer(questionId, "要")).toBe(true);
      await expect(pending).resolves.toBe("要");
      expect(session.allEvents().map((event) => event.type)).toContain("question/answered");
    } finally {
      store.closeAll();
      home.cleanup();
    }
  });

  it("returns null when execution is interrupted", async () => {
    const home = makeTempHome();
    const store = new SessionStore({ paths: home.paths, logger });
    const session = store.get(store.create("ws1", "提问中断").sessionId);
    try {
      const questions = new QuestionBroker(logger);
      const controller = new AbortController();
      const pending = questions.ask({
        session,
        question: "继续吗？",
        options: [],
        signal: controller.signal,
      });
      controller.abort();
      await expect(pending).resolves.toBeNull();
    } finally {
      store.closeAll();
      home.cleanup();
    }
  });
});

describe("Safe Command Argument Parsing", () => {
  it("rejects shell metacharacters", () => {
    expect(splitCommand("git status --porcelain").ok).toBe(true);
    expect(splitCommand("rm -rf / && echo hi").ok).toBe(false);
    expect(splitCommand("cat a | b").ok).toBe(false);
    expect(splitCommand("echo `whoami`").ok).toBe(false);
  });

  it("supports paired double and single quotes", () => {
    expect(splitCommand('node tool.js --msg "hello world"')).toEqual({
      ok: true,
      value: ["node", "tool.js", "--msg", "hello world"],
    });
    expect(splitCommand('echo "unterminated').ok).toBe(false);
  });
});
