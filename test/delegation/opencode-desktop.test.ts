import { describe, expect, it } from "vitest";
import { OpenCodeDesktopProvider } from "../../src/host/delegation/providers/opencode-desktop.js";
import type { DelegationRequest } from "../../src/shared/domain/delegation.js";
const req: DelegationRequest = { childId: "one", agentId: "opencode", workspace: process.cwd(), goal: "hello", instruction: "", mode: "write", signal: new AbortController().signal, onEvent: () => {} };
describe("OpenCode desktop compatibility", () => {
  it("connects to a healthy local service and collects the answer", async () => {
    const fake: typeof fetch = async (input) => { const path = new URL(String(input)).pathname; if (path === "/global/health") return Response.json({ healthy: true }); if (path === "/session") return Response.json({ id: "ses_1" }); if (path.endsWith("/message")) return Response.json({ info: {}, parts: [{ type: "text", text: "answer" }] }); return new Response(null, { status: 404 }); };
    const provider = new OpenCodeDesktopProvider({ homeDir: process.cwd(), endpoints: () => ["http://127.0.0.1:1234"], fetchImpl: fake });
    expect(await provider.delegate(req)).toMatchObject({ status: "ok", sessionId: "ses_1", answer: "answer" });
  });
  it("does not connect to non-local services, and does not refuse read-only tasks", async () => {
    let calls = 0;
    const provider = new OpenCodeDesktopProvider({ homeDir: process.cwd(), endpoints: () => ["http://example.com:1234"], fetchImpl: async () => { calls++; return Response.json({ healthy: true }); } });
    expect((await provider.detect()).installed).toBe(false);
    const result = await provider.delegate({ ...req, mode: "read-only" });
    expect(result).toMatchObject({ status: "failed", diagnostic: { category: "transport" } });
    expect(calls).toBe(0);
  });
});
