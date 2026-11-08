import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../../src/host/delegation/providers/acp.js";
import { spawnChild } from "../../src/host/boot/exec.js";
import { createStdioTransport, FakeRpcTransport, type JsonRpcTransport } from "../../src/host/delegation/transport.js";
import type { DelegationRequest } from "../../src/shared/domain/delegation.js";

const request = (): DelegationRequest => ({ childId: "one", agentId: "opencode", workspace: process.cwd(), goal: "test", instruction: "", mode: "write", signal: new AbortController().signal, onEvent: () => {} });

describe("OpenCode ACP", () => {
  it("sends the direct assignment over ACP without the user's original message or workspace boilerplate", async () => {
    const fake = new FakeRpcTransport([
      { request: "initialize", response: {} },
      { request: "session/new", response: { sessionId: "one" } },
      { request: "session/prompt", response: { stopReason: "end_turn" }, notifications: [{ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } }] },
    ]);
    let sent: unknown;
    const transport: JsonRpcTransport = { request: (method, params) => { if (method === "session/prompt") sent = params; return fake.request(method); }, notify: fake.notify.bind(fake), onNotification: fake.onNotification.bind(fake), onExit: fake.onExit.bind(fake), close: fake.close.bind(fake) };
    const result = await new AcpProvider({ providerId: "opencode", createTransport: () => transport, drainMs: 10 }).delegate({ ...request(), goal: "让 OpenCode 进行分析吧", instruction: "分析项目并提出改进建议。", taskType: "review" });
    expect(result).toMatchObject({ status: "ok" });
    expect(sent).toMatchObject({ prompt: [{ type: "text", text: "分析项目并提出改进建议。" }] });
  });

  it("handles real stdio frames and safely rejects permission requests", async () => {
    const script = fileURLToPath(new URL("../fixtures/providers/acp-server.cjs", import.meta.url));
    const provider = new AcpProvider({ providerId: "opencode", drainMs: 0, createTransport: (cwd) => createStdioTransport(spawnChild(process.execPath, [script], { cwd })) });
    expect(await provider.delegate(request())).toMatchObject({ status: "ok", answer: "permission rejected", sessionId: "ses_example" });
  });

  it("accepts a single permission request when explicitly configured", async () => {
    const script = fileURLToPath(new URL("../fixtures/providers/acp-server.cjs", import.meta.url));
    const events: string[] = [];
    const provider = new AcpProvider({ providerId: "opencode", drainMs: 0, createTransport: (cwd) => createStdioTransport(spawnChild(process.execPath, [script], { cwd }), { allowPermissions: () => true }) });
    expect(await provider.delegate({ ...request(), onEvent: (event) => { if (event.type === "trace") events.push(event.summary); } })).toMatchObject({ status: "ok", answer: "permission allowed" });
    expect(events).toContain("permission:allowed");
  });

  it("uses advertised session listing and maps paginated sessions", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } } },
      { request: "session/list", response: { sessions: [{ sessionId: "one", cwd: process.cwd(), title: "First", updatedAt: "2026-01-01T00:00:00Z" }], nextCursor: "next" } },
      { request: "session/list", response: { sessions: [{ sessionId: "two", cwd: process.cwd(), title: "Second" }] } },
    ]);
    const sessions = await new AcpProvider({ createTransport: () => transport }).listSessions(process.cwd(), { offset: 1, limit: 1 });
    expect(sessions).toMatchObject([{ sessionId: "two", title: "Second" }]);
  });

  it("loads a listed session and collects replayed history", async () => {
    const script = fileURLToPath(new URL("../fixtures/providers/acp-server.cjs", import.meta.url));
    const provider = new AcpProvider({ createTransport: (cwd) => createStdioTransport(spawnChild(process.execPath, [script], { cwd })) });
    expect(await provider.readSession("ses_example", { offset: 0, limit: 10 })).toEqual([{ type: "output", text: "old answer" }]);
  });

  it("verifies a resumable session without inventing history text", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: { agentCapabilities: { sessionCapabilities: { list: {}, resume: {} } } } },
      { request: "session/list", response: { sessions: [{ sessionId: "one", cwd: process.cwd() }] } },
    ]);
    expect(await new AcpProvider({ createTransport: () => transport }).readSession("one", { offset: 0, limit: 10 })).toEqual([{ type: "session", sessionId: "one" }]);
  });

  it("resumes an agent that advertises session/resume", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: { agentCapabilities: { sessionCapabilities: { resume: {} } } } },
      { request: "session/resume", response: {} },
      { request: "session/prompt", response: { stopReason: "end_turn" }, notifications: [{ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "continued" } } } }] },
    ]);
    expect(await new AcpProvider({ createTransport: () => transport, drainMs: 10 }).delegate({ ...request(), resumeSessionId: "one" })).toMatchObject({ status: "ok", answer: "continued", sessionId: "one" });
  });

  it("passes the Harness profile selection as an opaque provider/model pair", async () => {
    const fake = new FakeRpcTransport([
      { request: "initialize", response: {} },
      { request: "session/new", response: { sessionId: "one", configOptions: [{ id: "model", category: "model" }] } },
      { request: "session/set_config_option", response: {} },
      { request: "session/prompt", response: { stopReason: "end_turn" }, notifications: [{ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } }] },
    ]);
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport: JsonRpcTransport = { request: (method, params) => { calls.push({ method, params }); return fake.request(method); }, notify: fake.notify.bind(fake), onNotification: fake.onNotification.bind(fake), onExit: fake.onExit.bind(fake), close: fake.close.bind(fake) };
    const provider = new AcpProvider({ providerId: "deepseek-harness", createTransport: () => transport, drainMs: 10 });
    expect(await provider.delegate({ ...request(), model: "profile:test", modelConfig: { baseUrl: "https://example.test/v1", model: "model-a", apiKey: "secret-test" } })).toMatchObject({ status: "ok" });
    expect(calls.find((call) => call.method === "session/set_config_option")?.params).toMatchObject({ value: '["supercoder","model-a"]' });
    expect(JSON.stringify(calls)).not.toContain("secret-test");
  });

  it("does not mix replayed history into the next prompt answer", async () => {
    const script = fileURLToPath(new URL("../fixtures/providers/acp-server.cjs", import.meta.url));
    const provider = new AcpProvider({ drainMs: 0, createTransport: (cwd) => createStdioTransport(spawnChild(process.execPath, [script], { cwd })) });
    const result = await provider.delegate({ ...request(), resumeSessionId: "ses_example" });
    expect(result).toMatchObject({ status: "ok", answer: "permission rejected" });
  });

  it("does not report an incomplete turn as successful", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: { protocolVersion: 1 } }, { request: "session/new", response: { sessionId: "one" } },
      { request: "session/prompt", response: { stopReason: "max_turn_requests" } },
    ]);
    expect(await new AcpProvider({ createTransport: () => transport, drainMs: 5 }).delegate(request())).toMatchObject({ status: "failed", diagnostic: { category: "limit" } });
  });

  it("selects an explicitly requested model before sending the prompt", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: { protocolVersion: 1 } },
      { request: "session/new", response: { sessionId: "one", configOptions: [{ id: "model", category: "model" }] } },
      { request: "session/set_config_option", response: {} },
      { request: "session/prompt", response: { stopReason: "end_turn" }, notifications: [{ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } }] },
    ]);
    expect(await new AcpProvider({ createTransport: () => transport, drainMs: 10 }).delegate({ ...request(), model: "example/model" })).toMatchObject({ status: "ok", answer: "done" });
    expect(transport.remaining).toBe(0);
  });

  it("fails before prompting if the selected model cannot be applied", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: { protocolVersion: 1 } },
      { request: "session/new", response: { sessionId: "one" } },
    ]);
    expect(await new AcpProvider({ createTransport: () => transport }).delegate({ ...request(), model: "example/model" })).toMatchObject({ status: "failed", diagnostic: { stage: "handshake" } });
  });

  it("maps a SuperCoder profile to the injected OpenCode provider model", async () => {
    const fake = new FakeRpcTransport([
      { request: "initialize", response: {} }, { request: "session/new", response: { sessionId: "one", configOptions: [{ id: "model", category: "model" }] } },
      { request: "session/set_config_option", response: {} }, { request: "session/prompt", response: { stopReason: "end_turn" }, notifications: [{ method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "done" } } } }] },
    ]);
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport: JsonRpcTransport = { request: (method, params) => { calls.push({ method, params }); return fake.request(method); }, notify: fake.notify.bind(fake), onNotification: fake.onNotification.bind(fake), onExit: fake.onExit.bind(fake), close: fake.close.bind(fake) };
    const provider = new AcpProvider({ providerId: "opencode", createTransport: () => transport, drainMs: 10 });
    expect(await provider.delegate({ ...request(), model: "profile:test", modelConfig: { baseUrl: "https://example.test/v1", model: "custom-model", apiKey: "test-secret" } })).toMatchObject({ status: "ok" });
    expect(calls.find((call) => call.method === "session/set_config_option")?.params).toMatchObject({ value: "supercoder/custom-model" });
    expect(JSON.stringify(calls)).not.toContain("test-secret");
  });

  it("loads model options reported by ACP", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: {} }, { request: "session/new", response: { sessionId: "one", configOptions: [{ id: "model", category: "model", currentValue: "p/a", options: [{ value: "p/a", name: "A" }, { value: "p/b", name: "B" }] }] } },
    ]);
    expect(await new AcpProvider({ createTransport: () => transport }).listModels(process.cwd())).toEqual([{ id: "p/a", label: "A", current: true, provider: "p" }, { id: "p/b", label: "B", current: false, provider: "p" }]);
  });

  it("splits a provider prefix out of the display name so groups do not repeat it", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: {} }, { request: "session/new", response: { sessionId: "one", configOptions: [{ id: "model", category: "model", currentValue: "deepseek/v4", options: [{ value: "deepseek/v4", name: "DeepSeek/DeepSeek V4 Pro" }] }] } },
    ]);
    expect(await new AcpProvider({ createTransport: () => transport }).listModels(process.cwd())).toEqual([{ id: "deepseek/v4", label: "DeepSeek V4 Pro", current: true, provider: "DeepSeek" }]);
  });
});
