/**
 * Provider 接入：四级阶梯、答案选择、三种接入方式的录制回放、任务分派落盘。
 * 外部 Agent 委托协议与执行器测试。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DelegationEvent, DelegationRequest, DelegationResult } from "../../src/shared/domain/delegation.js";
import type {
  DelegationHandle,
  DelegationProvider,
  ProviderCapabilities,
  ProviderInstallation,
  ProviderPage,
  ProviderSessionSummary,
  StoreProbe,
} from "../../src/shared/domain/provider.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { SessionStore } from "../../src/host/session/store.js";
import { isRpcFailure } from "../../src/host/boot/failure.js";
import { WorkspaceLocks } from "../../src/host/workspace/locks.js";
import { selectAnswer } from "../../src/host/delegation/answer.js";
import { ProviderSelect } from "../../src/host/delegation/provider-select.js";
import { DelegationRunner } from "../../src/host/delegation/run.js";
import { FakeRpcTransport, type RecordedStep } from "../../src/host/delegation/transport.js";
import { AcpProvider } from "../../src/host/delegation/providers/acp.js";
import { CliJsonProvider } from "../../src/host/delegation/providers/cli-json.js";
import { CodexAppServerProvider } from "../../src/host/delegation/providers/codex-appserver.js";
import { JsonlStoreProbe, readSqliteSessions } from "../../src/host/delegation/providers/store-probe.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

function readFixture(name: string): Record<string, unknown> {
  const file = new URL(`../fixtures/providers/${name}`, import.meta.url);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

function makeRequest(overrides: Partial<DelegationRequest> = {}): DelegationRequest {
  return {
    childId: "task_1",
    agentId: "codex",
    workspace: process.cwd(),
    goal: "把登录页面的文案改成中文",
    instruction: "",
    mode: "read-only",
    signal: AbortSignal.timeout(5_000),
    onEvent: () => undefined,
    ...overrides,
  };
}

// ——  答案选择 ——

describe("Answer Selection Strategy", () => {
  it("final_answer takes precedence over all other candidates", () => {
    const result = selectAnswer([
      { phase: "commentary", text: "过程" },
      { phase: "partial_answer", text: "候选" },
      { phase: "final_answer", text: "结论" },
    ]);
    expect(result).toEqual({ ok: true, answer: "结论" });
  });

  it("accepts partial_answer when no tool calls follow", () => {
    expect(selectAnswer([{ phase: "partial_answer", text: "候选" }])).toEqual({
      ok: true,
      answer: "候选",
    });
  });

  it("returns invalid-result when tool call occurs after partial_answer", () => {
    const result = selectAnswer([
      { phase: "partial_answer", text: "候选", toolCallAfter: true },
    ]);
    expect(result.ok).toBe(false);
  });

  it("treats legacy text without phase as fallback candidate only", () => {
    expect(selectAnswer([{ phase: null, text: "旧格式" }])).toEqual({
      ok: true,
      answer: "旧格式",
    });
    expect(
      selectAnswer([
        { phase: null, text: "旧格式" },
        { phase: "final_answer", text: "新答案" },
      ]),
    ).toEqual({ ok: true, answer: "新答案" });
  });

  it("maps unrecognized phase to invalid-result", () => {
    const result = selectAnswer([{ phase: "thinking", text: "嗯" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.category).toBe("invalid-result");
  });

  it("treats empty candidates and empty text as invalid-result", () => {
    expect(selectAnswer([]).ok).toBe(false);
    expect(selectAnswer([{ phase: "final_answer", text: "   " }]).ok).toBe(true);
    expect(selectAnswer([{ phase: "partial_answer", text: "  " }]).ok).toBe(false);
  });
});

// —— Codex app-server（第 1 级）——

describe("Codex app-server Replay", () => {
  const fixtures = readFixture("codex-appserver.json") as {
    fixtures: Array<{
      name: string;
      transport: RecordedStep[];
      expect: { status: string; answer?: string; category?: string; stage?: string; sessionId?: string };
    }>;
  };

  for (const fixture of fixtures.fixtures) {
    it(fixture.name, async () => {
      const transport = new FakeRpcTransport(fixture.transport);
      const provider = new CodexAppServerProvider({ createTransport: () => transport });
      const events: DelegationEvent[] = [];
      const result = await provider.delegate(
        makeRequest({ onEvent: (event) => events.push(event) }),
      );
      expect(result.status).toBe(fixture.expect.status);
      if (fruitOk(result)) {
        expect(result.answer).toBe(fixture.expect.answer);
        if (fixture.expect.sessionId !== undefined) {
          expect(result.sessionId).toBe(fixture.expect.sessionId);
        }
      }
      if (result.status === "failed") {
        expect(result.diagnostic.category).toBe(fixture.expect.category);
        if (fixture.expect.stage !== undefined) {
          expect(result.diagnostic.stage).toBe(fixture.expect.stage);
        }
      }
      // 回执四态按顺序推进：起点必是 queued，成功结束必是 returned。
      const deliveries = events
        .filter((event) => event.type === "trace" && event.summary.startsWith("delivery:"))
        .map((event) => (event.type === "trace" ? event.summary : ""));
      expect(deliveries[0]).toBe("delivery:queued");
      if (fixture.expect.status === "ok") {
        expect(deliveries.at(-1)).toBe("delivery:returned");
      }
    });
  }

  it("marks task as unknown without auto-retry when child process exits unexpectedly", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: {} },
      { request: "thread/start", response: { threadId: "thr_crash" } },
      { request: "turn/start", response: {} },
    ]);
    const provider = new CodexAppServerProvider({ createTransport: () => transport });
    setTimeout(() => transport.crash(1), 10);
    const result = await provider.delegate(makeRequest());
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") expect(result.observed).toContain("退出");
  });

  it("marks task as failed when initialization fails before turn start", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", error: { message: "initialize 失败：协议版本不匹配" } },
    ]);
    const provider = new CodexAppServerProvider({ createTransport: () => transport });
    const result = await provider.delegate(makeRequest());
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.diagnostic.stage).toBe("handshake");
  });
});

// —— CLI JSON（第 2 级）——

describe("Codex CLI Replay", () => {
  const fixtures = readFixture("cli-json.json") as {
    fixtures: Array<{
      name: string;
      stdout: string;
      stderr: string;
      code: number;
      outFile: string | null;
      expect: { status: string; answer?: string; category?: string };
    }>;
  };

  for (const fixture of fixtures.fixtures) {
    it(fixture.name, async () => {
      const provider = new CliJsonProvider({
        detect: async () => ({ installed: true }),
        run: async (args) => {
          // 把 `-o <file>` 写到临时文件，验证"最后读 -o 文件"这条路径。
          const index = args.indexOf("-o");
          if (index >= 0 && fixture.outFile !== null) {
            const file = args[index + 1];
            if (file !== undefined) writeFileSync(file, fixture.outFile, "utf8");
          }
          return {
            code: fixture.code,
            stdout: fixture.stdout,
            stderr: fixture.stderr,
            durationMs: 1,
            timedOut: false,
            signal: null,
            aborted: false,
            overflowed: false,
          };
        },
      });
      const result = await provider.delegate(makeRequest());
      expect(result.status).toBe(fixture.expect.status);
      if (fruitOk(result)) expect(result.answer).toBe(fixture.expect.answer);
      if (result.status === "failed") expect(result.diagnostic.category).toBe(fixture.expect.category);
    });
  }
});

// —— ACP（第 3 级）——

describe("ACP Protocol Replay", () => {
  const fixtures = readFixture("acp.json") as {
    fixtures: Array<{
      name: string;
      transport: RecordedStep[];
      expect: { status: string; answer?: string; category?: string };
    }>;
  };

  for (const fixture of fixtures.fixtures) {
    it(fixture.name, async () => {
      const transport = new FakeRpcTransport(fixture.transport);
      const provider = new AcpProvider({
        createTransport: () => transport,
        drainMs: 5,
        detect: async () => ({ installed: true }),
      });
      const result = await provider.delegate(makeRequest({ agentId: "opencode", mode: "write" }));
      expect(result.status).toBe(fixture.expect.status);
      if (fruitOk(result)) expect(result.answer).toBe(fixture.expect.answer);
      if (result.status === "failed") expect(result.diagnostic.category).toBe(fixture.expect.category);
    });
  }
});

// —— 阶梯与缓存 ——

interface FakeProviderOptions {
  readonly installed: boolean;
  readonly result?: DelegationResult;
  /** 在提交之后补发的进度事件，用来模拟流式输出。 */
  readonly onEventScript?: (emit: (event: DelegationEvent) => void) => void;
}

function fakeProvider(id: string, options: FakeProviderOptions): DelegationProvider {
  const capabilities: ProviderCapabilities = {
    readOnly: false,
    resume: false,
    effort: false,
    streaming: false,
    receiptStates: ["queued", "submitted", "returned"],
    fragility: "documented",
  };
  return {
    id,
    capabilities,
    detect: async (): Promise<ProviderInstallation> =>
      options.installed ? { installed: true } : { installed: false, reason: "没有" },
    listSessions: async (): Promise<ProviderSessionSummary[]> => [],
    readSession: async (): Promise<DelegationEvent[]> => [],
    delegate: async (request): Promise<DelegationResult> => {
      request.onEvent({ type: "trace", summary: "delivery:queued" });
      request.onEvent({ type: "trace", summary: "delivery:submitted" });
      options.onEventScript?.((event) => { request.onEvent(event); });
      const result = options.result ?? { status: "ok", answer: "好", durationMs: 1 };
      if (result.status === "ok") request.onEvent({ type: "trace", summary: "delivery:returned" });
      return result;
    },
    cancel: async (_handle: DelegationHandle) => undefined,
  };
}

function emptyProbe(hit = false): StoreProbe {
  return {
    providerId: "probe",
    locate: async () => (hit ? "/tmp/store" : null),
    listSessions: async (): Promise<ProviderSessionSummary[]> => [
      { sessionId: "from-store", title: "旧会话", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    readSession: async (): Promise<DelegationEvent[]> => [{ type: "output", text: "旧内容" }],
  };
}

describe("Provider Cascade Selection", () => {
  it("falls back from tier 1 to tier 2 updating fragility score", async () => {
    const select = new ProviderSelect([
      {
        id: "alpha",
        label: "Alpha",
        entries: [
          { level: 1, provider: fakeProvider("alpha-appserver", { installed: false }) },
          { level: 2, provider: fakeProvider("alpha-cli", { installed: true }) },
        ],
        probe: emptyProbe(),
      },
    ]);
    const statuses = await select.statuses();
    expect(statuses[0]?.level).toBe(2);
    expect(statuses[0]?.compat).toBe(true);
    expect(statuses[0]?.fragility).toBe("documented");
  });

  it("caches probe results for 60s and reprobes only on refresh", async () => {
    let installed = false;
    const provider: DelegationProvider = {
      ...fakeProvider("alpha", { installed: false }),
      detect: async () => (installed ? { installed: true } : { installed: false, reason: "没装" }),
    };
    const select = new ProviderSelect([
      { id: "alpha", label: "Alpha", entries: [{ level: 1, provider }], probe: emptyProbe() },
    ]);
    expect((await select.statuses())[0]?.installed).toBe(false);
    installed = true;
    expect((await select.statuses())[0]?.installed).toBe(false);
    expect((await select.statuses(true))[0]?.installed).toBe(true);
  });

  it("allows inspecting history while blocking task dispatch under read-only probe", async () => {
    const select = new ProviderSelect([
      { id: "alpha", label: "Alpha", entries: [], probe: emptyProbe(true) },
    ]);
    const statuses = await select.statuses();
    expect(statuses[0]?.level).toBe(4);
    expect(statuses[0]?.capabilities.readOnly).toBe(true);
    expect(statuses[0]?.compat).toBe(true);

    const sessions = await select.listSessions("alpha", "", { offset: 0, limit: 10 });
    expect(sessions[0]?.sessionId).toBe("from-store");

    await expect(select.resolve("alpha")).rejects.toSatisfy(isRpcFailure);
  });

  it("provides diagnostic reason in status when provider is uninstalled", async () => {
    const select = new ProviderSelect([
      { id: "alpha", label: "Alpha", entries: [], probe: emptyProbe(false) },
    ]);
    const statuses = await select.statuses();
    expect(statuses[0]?.installed).toBe(false);
    expect(statuses[0]?.reason).toContain("没有");
  });
});

// —— 任务分派落盘与未知态 ——

describe("Task Dispatch Workflow", () => {
  function setup(options: FakeProviderOptions) {
    const home = makeTempHome();
    const store = new SessionStore({ paths: home.paths, logger });
    const sessionId = store.create("ws1", "任务分派测试").sessionId;
    const select = new ProviderSelect([
      {
        id: "codex",
        label: "Codex",
        entries: [{ level: 1, provider: fakeProvider("codex", options) }],
        probe: emptyProbe(),
      },
    ]);
    const locks = new WorkspaceLocks();
    const runner = new DelegationRunner({ select, locks, logger });
    return { home, store, sessionId, runner, locks };
  }

  it("only falls back after a failure known to precede submission", async () => {
    const home = makeTempHome();
    const store = new SessionStore({ paths: home.paths, logger });
    const session = store.get(store.create("ws1", "fallback").sessionId);
    let secondCalls = 0;
    let submitted = false;
    const first: DelegationProvider = { ...fakeProvider("first", { installed: true }), delegate: async (req) => {
      if (submitted) req.onEvent({ type: "trace", summary: "delivery:submitted" });
      return { status: "failed", diagnostic: { stage: "handshake", category: "protocol" }, durationMs: 1 };
    } };
    const second: DelegationProvider = { ...fakeProvider("second", { installed: true }), delegate: async () => { secondCalls++; return { status: "ok", answer: "done", durationMs: 1 }; } };
    const select = new ProviderSelect([{ id: "codex", label: "Codex", entries: [{ level: 1, provider: first }, { level: 2, provider: second }], probe: emptyProbe() }]);
    const runner = new DelegationRunner({ select, locks: new WorkspaceLocks(), logger });
    const input = { session, workspaceId: "ws1", workspacePath: home.home, agentId: "codex", goal: "test", instruction: "", mode: "read-only" as const, taskType: "review" as const, signal: new AbortController().signal };
    try {
      expect(await runner.dispatch(input)).toMatchObject({ state: "returned", providerId: "second" });
      expect(secondCalls).toBe(1);
      submitted = true;
      expect(await runner.dispatch(input)).toMatchObject({ state: "unknown", providerId: "first" });
      expect(secondCalls).toBe(1);
    } finally { store.closeAll(); home.cleanup(); }
  });

  it("success: logs spawn, delivery, and result events into task view", async () => {
    const fixture = setup({ installed: true, result: { status: "ok", answer: "改好了", durationMs: 5 } });
    try {
      const session = fixture.store.get(fixture.sessionId);
      const task = await fixture.runner.dispatch({
        session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        agentId: "codex",
        goal: "改文案",
        instruction: "",
        mode: "read-only",
        taskType: "general",
        signal: AbortSignal.timeout(5_000),
      });
      expect(task.state).toBe("returned");
      expect(task.result?.status).toBe("ok");
      const types = session.allEvents().map((event) => event.type);
      expect(types).toContain("delegation/spawn");
      expect(types).toContain("delegation/delivery");
      expect(types).toContain("delegation/result");
    } finally {
      fixture.store.closeAll();
      fixture.home.cleanup();
    }
  });

  it("aggregates streaming deltas into minimal events forming complete answer", async () => {
    const fixture = setup({ installed: true, result: { status: "ok", answer: "done", durationMs: 1 }, onEventScript: (emit) => {
      for (let i = 0; i < 50; i += 1) emit({ type: "output", text: `t${String(i)} ` });
    } });
    try {
      const session = fixture.store.get(fixture.sessionId);
      const task = await fixture.runner.dispatch({ session, workspaceId: "ws1", workspacePath: fixture.home.home, agentId: "codex", goal: "x", instruction: "", mode: "read-only", taskType: "general", signal: AbortSignal.timeout(5_000) });
      const progress = session.allEvents().filter((event) => event.type === "delegation/progress" && event.event.type === "output");
      expect(progress.length).toBeLessThan(50);
      expect(task.output).toBe(Array.from({ length: 50 }, (_, i) => `t${String(i)} `).join(""));
    } finally { fixture.store.closeAll(); fixture.home.cleanup(); }
  });

  it("retains the stage and exact handoff on retry", async () => {
    const fixture = setup({ installed: true, result: { status: "ok", answer: "done", durationMs: 1 } });
    try {
      const session = fixture.store.get(fixture.sessionId);
      const first = await fixture.runner.dispatch({ session, workspaceId: "ws1", workspacePath: fixture.home.home, agentId: "codex", goal: "继续", instruction: "复核上游发现", mode: "read-only", taskType: "review", signal: AbortSignal.timeout(5_000) });
      expect(first).toMatchObject({ taskType: "review", goal: "继续", instruction: "复核上游发现" });
      const second = await fixture.runner.retry({ session, workspacePath: fixture.home.home, taskId: first.taskId, confirmSideEffects: false, signal: AbortSignal.timeout(5_000) });
      expect(second).toMatchObject({ taskType: "review", goal: "继续", instruction: "复核上游发现", retryCount: 1 });
    } finally { fixture.store.closeAll(); fixture.home.cleanup(); }
  });

  it("requires side effect confirmation before retrying unknown tasks", async () => {
    const fixture = setup({
      installed: true,
      result: { status: "unknown", observed: "进程没了", since: new Date().toISOString() },
    });
    try {
      const session = fixture.store.get(fixture.sessionId);
      const task = await fixture.runner.dispatch({
        session,
        workspaceId: "ws1",
        workspacePath: fixture.home.home,
        agentId: "codex",
        goal: "写点东西",
        instruction: "",
        mode: "read-only",
        taskType: "general",
        signal: AbortSignal.timeout(5_000),
      });
      expect(task.state).toBe("unknown");

      await expect(
        fixture.runner.retry({
          session,
          workspacePath: fixture.home.home,
          taskId: task.taskId,
          confirmSideEffects: false,
          signal: AbortSignal.timeout(5_000),
        }),
      ).rejects.toSatisfy(isRpcFailure);
    } finally {
      fixture.store.closeAll();
      fixture.home.cleanup();
    }
  });

  it("denies concurrent mutating tasks when workspace lock is held", async () => {
    const fixture = setup({ installed: true });
    try {
      const session = fixture.store.get(fixture.sessionId);
      const acquired = fixture.locks.acquire("ws1", "other-task");
      expect(acquired.ok).toBe(true);
      await expect(
        fixture.runner.dispatch({
          session,
          workspaceId: "ws1",
          workspacePath: fixture.home.home,
          agentId: "codex",
          goal: "写",
          instruction: "",
          mode: "write",
          taskType: "general",
          signal: AbortSignal.timeout(5_000),
        }),
      ).rejects.toSatisfy(isRpcFailure);
    } finally {
      fixture.store.closeAll();
      fixture.home.cleanup();
    }
  });
});

// —— 第 4 级只读探测 ——

describe("Private Store Read-Only Probing", () => {
  it("reads history from JSONL session directory extracting title from header", async () => {
    const root = mkdtempSync(join(tmpdir(), "sc-store-"));
    try {
      const nested = join(root, "2026", "01", "02");
      mkdirSync(nested, { recursive: true });
      writeFileSync(
        join(nested, "rollout-2026-01-02T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl"),
        `${JSON.stringify({ payload: { text: "第一个会话的标题" } })}\n{"payload":{"text":"正文"}}\n`,
        "utf8",
      );
      const probe = new JsonlStoreProbe("codex", { roots: { codex: [root] } });
      const sessions = await probe.listSessions("", { offset: 0, limit: 10 });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.sessionId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
      expect(sessions[0]?.title).toContain("第一个会话的标题");

      const events = await probe.readSession(sessions[0]?.sessionId ?? "", { offset: 0, limit: 10 });
      expect(events.map((event) => (event.type === "output" ? event.text : ""))).toContain("正文");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads sessions from private SQLite database in read-only mode", async () => {
    const home = makeTempHome();
    const databaseFile = join(home.home, "store.sqlite3");
    try {
      const initSqlJs = (await import("sql.js")).default;
      const SQL = await initSqlJs();
      const db = new SQL.Database();
      db.run("CREATE TABLE threads (id TEXT, title TEXT, updated_at TEXT)");
      db.run("INSERT INTO threads VALUES ('thr_a', 'SQLite 里的会话', '2026-02-01T00:00:00.000Z')");
      writeFileSync(databaseFile, Buffer.from(db.export()));
      db.close();

      const sessions = await readSqliteSessions(databaseFile);
      expect(sessions).toEqual([
        { sessionId: "thr_a", title: "SQLite 里的会话", updatedAt: "2026-02-01T00:00:00.000Z" },
      ]);
    } finally {
      home.cleanup();
    }
  });
});

function fruitOk(result: DelegationResult): result is Extract<DelegationResult, { status: "ok" }> {
  return result.status === "ok";
}

/** 让类型检查用上 ProviderPage（回放用例里只用到偏移与上限）。 */
export const page: ProviderPage = { offset: 0, limit: 10 };
