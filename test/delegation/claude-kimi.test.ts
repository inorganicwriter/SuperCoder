import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider, parseClaudeOutput } from "../../src/host/delegation/providers/claude-code.js";
import { KimiStoreProbe } from "../../src/host/delegation/providers/kimi-store.js";
import { KimiCodeProvider } from "../../src/host/delegation/providers/kimi.js";
import type { DelegationRequest } from "../../src/shared/domain/delegation.js";

const req: DelegationRequest = {
  childId: "one",
  agentId: "claude-code",
  workspace: process.cwd(),
  goal: "hello",
  instruction: "",
  mode: "write",
  signal: new AbortController().signal,
  onEvent: () => {},
};

const reply = (stdout: string, code = 0) => async () => ({
  code,
  signal: null,
  stdout,
  stderr: "",
  durationMs: 1,
  timedOut: false,
  aborted: false,
  overflowed: false,
});

describe("Claude Code CLI", () => {
  it("sends the task on stdin and reads the result field", async () => {
    const seen: { args: readonly string[]; stdin: string }[] = [];
    const provider = new ClaudeCodeProvider({
      detect: async () => ({ installed: true, binaryPath: "claude" }),
      run: async (args, stdin) => {
        seen.push({ args, stdin });
        return (await reply(JSON.stringify({ result: "done", session_id: "s1", is_error: false }))()) as never;
      },
    });
    const result = await provider.delegate(req);
    expect(result).toMatchObject({ status: "ok", answer: "done", sessionId: "s1" });
    expect(seen[0]?.stdin).toBe("hello");
    expect(seen[0]?.args).toContain("--permission-mode");
    expect(seen[0]?.args).toContain("acceptEdits");
  });

  it("uses Claude's own plan mode for read-only tasks", async () => {
    const seen: string[][] = [];
    const provider = new ClaudeCodeProvider({
      detect: async () => ({ installed: true, binaryPath: "claude" }),
      run: async (args) => {
        seen.push([...args]);
        return (await reply(JSON.stringify({ result: "ok", is_error: false }))()) as never;
      },
    });
    expect(await provider.delegate({ ...req, mode: "read-only" })).toMatchObject({ status: "ok" });
    expect(seen[0]).toContain("plan");
  });

  it("resumes the given session", async () => {
    const seen: string[][] = [];
    const provider = new ClaudeCodeProvider({
      detect: async () => ({ installed: true, binaryPath: "claude" }),
      run: async (args) => {
        seen.push([...args]);
        return (await reply(JSON.stringify({ result: "ok", is_error: false }))()) as never;
      },
    });
    await provider.delegate({ ...req, resumeSessionId: "s1" });
    const at = seen[0]?.indexOf("--resume") ?? -1;
    expect(at).toBeGreaterThan(-1);
    expect(seen[0]?.[at + 1]).toBe("s1");
  });

  it("reports a CLI error as failed instead of returning its text as the answer", async () => {
    const provider = new ClaudeCodeProvider({
      detect: async () => ({ installed: true, binaryPath: "claude" }),
      run: async () => (await reply(JSON.stringify({ result: "rate limit exceeded", is_error: true }), 1)()) as never,
    });
    const result = await provider.delegate(req);
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.diagnostic.category).toBe("limit");
  });

  it("treats unparseable output as invalid-result, not as an answer", async () => {
    const provider = new ClaudeCodeProvider({
      detect: async () => ({ installed: true, binaryPath: "claude" }),
      run: async () => (await reply("not json at all")()) as never,
    });
    expect(await provider.delegate(req)).toMatchObject({
      status: "failed",
      diagnostic: { category: "invalid-result" },
    });
  });

  it("streams text deltas as they arrive and takes the final answer from the result line", async () => {
    const lines = [
      { type: "system", subtype: "init" },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hidden" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "第一段" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "，第二段" } } },
      { type: "assistant", message: { content: [{ type: "text", text: "第一段，第二段" }] } },
      { type: "result", subtype: "success", result: "第一段，第二段", session_id: "s9", is_error: false },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n";
    const outputs: string[] = [];
    const deliveries: string[] = [];
    const provider = new ClaudeCodeProvider({
      detect: async () => ({ installed: true, binaryPath: "claude" }),
      run: async (_args, _stdin, onStdout) => {
        // 故意把一行 JSON 切成两段送达，验证按行拼接。
        const cut = lines.indexOf("第二段") - 3;
        onStdout?.(lines.slice(0, cut));
        onStdout?.(lines.slice(cut));
        return { code: 0, signal: null, stdout: lines, stderr: "", durationMs: 1, timedOut: false, aborted: false, overflowed: false };
      },
    });
    const result = await provider.delegate({
      ...req,
      onEvent: (event) => {
        if (event.type === "output") outputs.push(event.text);
        if (event.type === "trace") deliveries.push(event.summary);
      },
    });
    expect(outputs).toEqual(["第一段", "，第二段"]);
    expect(result).toMatchObject({ status: "ok", answer: "第一段，第二段", sessionId: "s9" });
    expect(deliveries.indexOf("delivery:submitted")).toBeGreaterThan(deliveries.indexOf("delivery:queued"));
  });

  it("parses a JSON object that follows log lines", () => {
    const parsed = parseClaudeOutput('warn: something\n{"result":"a","session_id":"s","is_error":false}');
    expect(parsed).toEqual({ result: "a", sessionId: "s", isError: false });
  });
});

describe("Kimi Code history", () => {
  const build = (): { dir: string; cleanup: () => void } => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-store-"));
    const sessionDir = join(dir, "wd_demo_abc", "session_11111111-2222-3333-4444-555555555555");
    mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
    writeFileSync(
      join(sessionDir, "state.json"),
      JSON.stringify({ id: "session_11111111-2222-3333-4444-555555555555", title: "Demo", updatedAt: 1000, archived: false }),
    );
    writeFileSync(
      join(sessionDir, "agents", "main", "wire.jsonl"),
      [
        JSON.stringify({ type: "turn.prompt", input: [{ type: "text", text: "question" }] }),
        JSON.stringify({
          type: "agent.message.appended",
          message: { message: { role: "assistant", content: [{ type: "think", think: "hidden" }, { type: "text", text: "answer" }] } },
        }),
      ].join("\n"),
    );
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it("lists sessions from state.json and reads assistant text only", async () => {
    const fixture = build();
    try {
      const probe = new KimiStoreProbe({ sessionsDir: fixture.dir });
      expect(await probe.listSessions("", { offset: 0, limit: 10 })).toEqual([
        { sessionId: "session_11111111-2222-3333-4444-555555555555", title: "Demo", updatedAt: new Date(1000).toISOString() },
      ]);
      expect(await probe.readSession("session_11111111-2222-3333-4444-555555555555", { offset: 0, limit: 10 })).toEqual([
        { type: "output", text: "answer" },
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  it("returns nothing when the directory does not exist", async () => {
    const probe = new KimiStoreProbe({ sessionsDir: join(tmpdir(), "kimi-missing-does-not-exist") });
    expect(await probe.locate("")).toBeNull();
    expect(await probe.listSessions("", { offset: 0, limit: 10 })).toEqual([]);
  });
});

describe("Kimi Code local service", () => {
  const fake = (): { fetcher: typeof fetch; calls: { path: string; body: unknown }[] } => {
    const calls: { path: string; body: unknown }[] = [];
    let turnRead = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ path, body });
      const ok = (data: unknown): Response => Response.json({ code: 0, msg: "success", data });
      if (path === "/api/v1/healthz") return ok({ ok: true });
      if (path === "/api/v1/models") return ok({ items: [{ model: "kimi-code/k3", display_name: "K3" }] });
      if (path === "/api/v1/sessions" && init?.method === "POST") return ok({ id: "session_x" });
      if (path.endsWith("/profile")) return ok({});
      if (path.endsWith("/prompts")) return ok({ prompt_id: "p1", created_at: "2026-01-01T00:00:10.000Z" });
      if (path === "/api/v1/sessions/session_x") {
        turnRead += 1;
        // 第一次读还在跑；之后落定。
        return ok(turnRead > 1
          ? { busy: false, last_turn_reason: "completed", updated_at: "2026-01-01T00:00:20.000Z" }
          : { busy: true, last_turn_reason: "running", updated_at: "2026-01-01T00:00:11.000Z" });
      }
      if (path.endsWith("/messages")) {
        // 服务端按新到旧返回，且混着上一轮的旧回复。
        return ok({ items: [
          { role: "assistant", created_at: "2026-01-01T00:00:19.000Z", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "KIMI-OK" }] },
          { role: "assistant", created_at: "2026-01-01T00:00:01.000Z", content: [{ type: "text", text: "old turn" }] },
        ] });
      }
      return new Response(null, { status: 404 });
    };
    return { fetcher, calls };
  };

  it("detects the local service and reports its models", async () => {
    const { fetcher } = fake();
    const provider = new KimiCodeProvider({
      endpoint: async () => ({ url: "http://127.0.0.1:49371", token: "t" }),
      fetchImpl: fetcher,
    });
    expect(await provider.detect()).toMatchObject({ installed: true });
    expect(await provider.listModels("")).toEqual([{ id: "kimi-code/k3", label: "K3" }]);
  });

  it("creates a session, sets the model, submits the prompt and polls until completed", async () => {
    const { fetcher, calls } = fake();
    const provider = new KimiCodeProvider({
      endpoint: async () => ({ url: "http://127.0.0.1:49371", token: "t" }),
      fetchImpl: fetcher,
      pollMs: 1,
    });
    const result = await provider.delegate({ ...req, agentId: "kimi-code", model: "kimi-code/k3" });
    expect(result).toMatchObject({ status: "ok", answer: "KIMI-OK", sessionId: "session_x" });
    const profile = calls.find((call) => call.path.endsWith("/profile"));
    expect(profile?.body).toMatchObject({ agent_config: { model: "kimi-code/k3" } });
    const prompt = calls.find((call) => call.path.endsWith("/prompts"));
    expect(prompt?.body).toMatchObject({ content: [{ type: "text", text: "hello" }] });
  });

  it("uses Kimi's plan mode for read-only tasks", async () => {
    const { fetcher, calls } = fake();
    const provider = new KimiCodeProvider({
      endpoint: async () => ({ url: "http://127.0.0.1:49371", token: "t" }),
      fetchImpl: fetcher,
      pollMs: 1,
    });
    await provider.delegate({ ...req, agentId: "kimi-code", mode: "read-only" });
    expect(calls.find((call) => call.path.endsWith("/profile"))?.body).toMatchObject({
      agent_config: { plan_mode: true },
    });
  });

  it("never talks to a non-local endpoint", async () => {
    let called = false;
    const provider = new KimiCodeProvider({
      endpoint: async () => ({ url: "http://example.com:49371", token: "t" }),
      findExe: async () => null,
      fetchImpl: async () => {
        called = true;
        return Response.json({ ok: true });
      },
    });
    expect((await provider.detect()).installed).toBe(false);
    expect(called).toBe(false);
  });

  it("reports a failed turn as failed rather than an empty answer", async () => {
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      const ok = (data: unknown): Response => Response.json({ code: 0, msg: "success", data });
      if (path === "/api/v1/healthz") return ok({ ok: true });
      if (path === "/api/v1/sessions" ) return ok({ id: "s" });
      if (path.endsWith("/profile")) return ok({});
      if (path.endsWith("/prompts")) return ok({ prompt_id: "p", created_at: "2026-01-01T00:00:10.000Z" });
      if (path.endsWith("/warnings")) return ok({ warnings: ["model not configured"] });
      return ok({ busy: false, last_turn_reason: "failed", updated_at: "2026-01-01T00:00:11.000Z" });
    };
    const provider = new KimiCodeProvider({
      endpoint: async () => ({ url: "http://127.0.0.1:49371", token: "t" }),
      fetchImpl: fetcher,
      pollMs: 1,
    });
    const result = await provider.delegate({ ...req, agentId: "kimi-code" });
    expect(result.status).toBe("failed");
  });

  it("on resume, does not mistake the previous turn's completed state for the new one", async () => {
    let reads = 0;
    const fetcher: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      const ok = (data: unknown): Response => Response.json({ code: 0, msg: "success", data });
      if (path === "/api/v1/healthz") return ok({ ok: true });
      if (path.endsWith("/prompts")) return ok({ prompt_id: "p2", created_at: "2026-01-01T00:01:00.000Z" });
      if (path === "/api/v1/sessions/old") {
        reads += 1;
        // 前两次读：上一轮残留的 completed，更新时间早于投递 —— 不能算数。
        if (reads <= 2) return ok({ busy: false, last_turn_reason: "completed", updated_at: "2026-01-01T00:00:30.000Z" });
        return ok({ busy: false, last_turn_reason: "completed", updated_at: "2026-01-01T00:01:05.000Z" });
      }
      if (path.endsWith("/messages")) {
        return ok({ items: [
          { role: "assistant", created_at: "2026-01-01T00:01:04.000Z", content: [{ type: "text", text: "new answer" }] },
          { role: "assistant", created_at: "2026-01-01T00:00:29.000Z", content: [{ type: "text", text: "previous answer" }] },
        ] });
      }
      return ok({});
    };
    const provider = new KimiCodeProvider({
      endpoint: async () => ({ url: "http://127.0.0.1:49371", token: "t" }),
      fetchImpl: fetcher,
      pollMs: 1,
    });
    const result = await provider.delegate({ ...req, agentId: "kimi-code", resumeSessionId: "old" });
    expect(result).toMatchObject({ status: "ok", answer: "new answer", sessionId: "old" });
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("counts an installed but stopped Kimi as available, and launches it when a task arrives", async () => {
    let running = false;
    const launched: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      if (!running) throw new Error("connect ECONNREFUSED");
      const path = new URL(String(input)).pathname;
      const ok = (data: unknown): Response => Response.json({ code: 0, msg: "success", data });
      if (path === "/api/v1/healthz") return ok({ ok: true });
      if (path === "/api/v1/sessions") return ok({ id: "s" });
      if (path.endsWith("/prompts")) return ok({ prompt_id: "p", created_at: "2026-01-01T00:00:10.000Z" });
      if (path === "/api/v1/sessions/s") return ok({ busy: false, last_turn_reason: "completed", updated_at: "2026-01-01T00:00:20.000Z" });
      if (path.endsWith("/messages")) return ok({ items: [{ role: "assistant", created_at: "2026-01-01T00:00:19.000Z", content: [{ type: "text", text: "launched ok" }] }] });
      return ok({});
    };
    const provider = new KimiCodeProvider({
      endpoint: async () => ({ url: "http://127.0.0.1:49371", token: "t" }),
      fetchImpl: fetcher,
      findExe: async () => "C:/Kimi/Kimi Code.exe",
      launch: (exe) => { launched.push(exe); running = true; },
      pollMs: 1,
    });
    expect(await provider.detect()).toMatchObject({ installed: true, binaryPath: "C:/Kimi/Kimi Code.exe" });
    expect(launched).toEqual([]);
    const result = await provider.delegate({ ...req, agentId: "kimi-code" });
    expect(launched).toEqual(["C:/Kimi/Kimi Code.exe"]);
    expect(result).toMatchObject({ status: "ok", answer: "launched ok" });
  });

  it("reads models with their provider from config.toml while Kimi is not running", async () => {
    const home = mkdtempSync(join(tmpdir(), "kimi-config-"));
    try {
      mkdirSync(join(home, ".kimi-code"), { recursive: true });
      writeFileSync(join(home, ".kimi-code", "config.toml"), [
        'default_model = "kimi-code/k3"',
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        '[models."kimi-code/k3"]',
        'provider = "managed:kimi-code"',
        'display_name = "K3"',
        '[models."custom/other"]',
        'provider = "openrouter"',
        'display_name = "Other"',
      ].join("\n"));
      const provider = new KimiCodeProvider({ homeDir: home, endpoint: async () => null, findExe: async () => null });
      expect(await provider.listModels("")).toEqual([
        { id: "kimi-code/k3", label: "K3", provider: "Kimi" },
        { id: "custom/other", label: "Other", provider: "openrouter" },
      ]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
