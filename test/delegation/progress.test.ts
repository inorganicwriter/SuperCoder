import { describe, expect, it } from "vitest";
import { shapeOf, diffShape } from "../../src/shared/session/shape.js";
import { SessionDerivation } from "../../src/shared/session/derive.js";
import { CodexAppServerProvider } from "../../src/host/delegation/providers/codex-appserver.js";
import { FakeRpcTransport, type JsonRpcTransport } from "../../src/host/delegation/transport.js";
import type { DelegationEvent, DelegationRequest } from "../../src/shared/domain/delegation.js";
import { SessionStore } from "../../src/host/session/store.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { makeTempHome } from "../helpers/temp.js";

describe("delegation history and live progress", () => {
  it("keeps old log headers compatible and still rejects unrelated shape drift", () => {
    const current = shapeOf();
    const old = current.split(";").filter((entry) => !entry.startsWith("delegation/progress:")).join(";");
    expect(diffShape(old, current)).toBeNull();
    expect(diffShape(old.replace("user/message:seq,at,text,attachments", "user/message:seq,at,body,attachments"), current)).not.toBeNull();
  });
  it("retains native session and streamed text after the result", () => {
    const view = new SessionDerivation({ sessionId: "s", workspaceId: "w" });
    view.apply({ type: "delegation/spawn", seq: 1, at: "t", childId: "c", provider: "codex", agentId: "codex", goal: "x", instruction: "", mode: "read-only" });
    view.apply({ type: "delegation/progress", seq: 2, at: "t", childId: "c", event: { type: "session", sessionId: "native" } });
    view.apply({ type: "delegation/progress", seq: 3, at: "t", childId: "c", event: { type: "output", text: "hello" } });
    view.apply({ type: "delegation/progress", seq: 4, at: "t", childId: "c", event: { type: "trace", summary: "model:example/model" } });
    view.apply({ type: "delegation/result", seq: 5, at: "t", childId: "c", result: { status: "ok", answer: "done", durationMs: 1 } });
    expect(view.view().tasks[0]).toMatchObject({ nativeSessionId: "native", selectedModel: "example/model", output: "hello", result: { answer: "done" } });
  });
  it("replays recorded progress after the session store restarts", () => {
    const home = makeTempHome();
    const first = new SessionStore({ paths: home.paths, logger: silentLogger() });
    try {
      const id = first.create("ws", "progress").sessionId;
      const session = first.get(id);
      session.append("delegation/spawn", { childId: "c", provider: "codex", agentId: "codex", goal: "x", instruction: "", mode: "read-only" });
      session.append("delegation/progress", { childId: "c", event: { type: "session", sessionId: "native" } });
      session.append("delegation/progress", { childId: "c", event: { type: "output", text: "hello" } });
      first.closeAll();
      const reopened = new SessionStore({ paths: home.paths, logger: silentLogger() });
      try {
        expect(reopened.scanAll().rejected).toEqual([]);
        expect(reopened.get(id).view().tasks[0]).toMatchObject({ nativeSessionId: "native", output: "hello" });
      } finally { reopened.closeAll(); }
    } finally { first.closeAll(); home.cleanup(); }
  });
  it("persists read-only Codex threads and avoids duplicate streamed text", async () => {
    const fake = new FakeRpcTransport([
      { request: "initialize", response: {} }, { request: "thread/start", response: { thread: { id: "native" } } },
      { request: "turn/start", response: {}, notifications: [
        { method: "item/agentMessage/delta", params: { itemId: "i", delta: "hello" } },
        { method: "item/completed", params: { item: { id: "i", type: "agentMessage", text: "hello", phase: "final_answer" } } },
        { method: "turn/completed", params: { turn: { status: "completed" } } },
      ] },
    ]);
    const requests: Array<{ method: string; params: unknown }> = [];
    const transport: JsonRpcTransport = { request: (method, params) => { requests.push({ method, params }); return fake.request(method); }, notify: fake.notify.bind(fake), onNotification: fake.onNotification.bind(fake), onExit: fake.onExit.bind(fake), close: fake.close.bind(fake) };
    const events: DelegationEvent[] = [];
    const req: DelegationRequest = { childId: "c", agentId: "codex", workspace: process.cwd(), goal: "hi", instruction: "", mode: "read-only", signal: new AbortController().signal, onEvent: (event) => events.push(event) };
    expect(await new CodexAppServerProvider({ createTransport: () => transport }).delegate(req)).toMatchObject({ status: "ok", answer: "hello" });
    expect(requests.find((item) => item.method === "thread/start")?.params).toMatchObject({ ephemeral: false, sandbox: "read-only" });
    expect(events.filter((event) => event.type === "output")).toEqual([{ type: "output", text: "hello" }]);
  });
});
