import { describe, expect, it } from "vitest";
import { CodexAppServerProvider } from "../../src/host/delegation/providers/codex-appserver.js";
import { AcpProvider } from "../../src/host/delegation/providers/acp.js";
import { CommandProvider } from "../../src/host/delegation/providers/command.js";
import { FakeRpcTransport } from "../../src/host/delegation/transport.js";
import type { DelegationRequest } from "../../src/shared/domain/delegation.js";
import { createProviderFamilies } from "../../src/host/delegation/registry.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPermissionPreferences } from "../../src/host/delegation/permission-preferences.js";
import { fileURLToPath } from "node:url";
import { spawnChild } from "../../src/host/boot/exec.js";
import { createStdioTransport } from "../../src/host/delegation/transport.js";

const request = (): DelegationRequest => ({ childId: "one", agentId: "codex", workspace: process.cwd(), goal: "hello", instruction: "", mode: "read-only", signal: new AbortController().signal, onEvent: () => {} });

describe("current agent protocols", () => {
  it("answers Codex command approvals according to the selected policy", async () => {
    const script = fileURLToPath(new URL("../fixtures/providers/codex-approval.cjs", import.meta.url));
    for (const allowed of [false, true]) {
      const transport = createStdioTransport(spawnChild(process.execPath, [script], { cwd: process.cwd() }), { allowPermissions: () => allowed });
      try { expect(await transport.request("test", {})).toEqual({ decision: allowed ? "accept" : "decline" }); }
      finally { transport.close(); }
    }
  });

  it("lets a per-agent policy override the configured ACP default", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-permissions-"));
    try {
      const policies = new AgentPermissionPreferences(join(dir, "permissions.json"));
      expect(policies.get("custom")).toBe("deny");
      policies.set("*", "allow");
      expect(policies.get("custom")).toBe("allow");
      policies.set("custom", "deny");
      expect(policies.get("custom")).toBe("deny");
      expect(policies.get("other")).toBe("allow");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("lists Codex models and ignores hidden models omitted by the server", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: {} },
      { request: "model/list", response: { data: [{ model: "model-a", displayName: "Model A", isDefault: true }] } },
    ]);
    expect(await new CodexAppServerProvider({ createTransport: () => transport }).listModels(process.cwd())).toEqual([{ id: "model-a", label: "Model A", current: true, provider: "OpenAI" }]);
  });

  it("waits for Codex to recover from a retryable error", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: {} },
      { request: "thread/start", response: { thread: { id: "t1" } } },
      { request: "turn/start", response: {}, notifications: [
        { method: "error", params: { error: { message: "retrying" }, willRetry: true } },
        { method: "item/completed", params: { item: { type: "agentMessage", text: "recovered", phase: "final_answer" } } },
        { method: "turn/completed", params: { turn: { status: "completed" } } },
      ] },
    ]);
    expect(await new CodexAppServerProvider({ createTransport: () => transport }).delegate(request())).toMatchObject({ status: "ok", answer: "recovered" });
  });

  it("parses the current Codex thread and agent message shapes", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: {} },
      { request: "thread/start", response: { thread: { id: "t1" } } },
      { request: "turn/start", response: { turn: { id: "turn1" } }, notifications: [
        { method: "item/completed", params: { item: { type: "commandExecution" } } },
        { method: "item/completed", params: { item: { type: "agentMessage", text: "answer", phase: "final_answer" } } },
        { method: "turn/completed", params: { turn: { status: "completed" } } },
      ] },
    ]);
    expect(await new CodexAppServerProvider({ createTransport: () => transport }).delegate(request())).toMatchObject({ status: "ok", answer: "answer", sessionId: "t1" });
  });

  it("reports a submitted turn timeout as unknown", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: {} }, { request: "thread/start", response: { thread: { id: "t1" } } }, { request: "turn/start", response: {} },
    ]);
    const keepAlive = setTimeout(() => {}, 100);
    try { expect((await new CodexAppServerProvider({ createTransport: () => transport, turnTimeoutMs: 5 }).delegate(request())).status).toBe("unknown"); }
    finally { clearTimeout(keepAlive); }
  });

  it("runs ACP read-only tasks instead of refusing them (write access is a superset)", async () => {
    let spawned = false;
    const provider = new AcpProvider({ createTransport: () => { spawned = true; return new FakeRpcTransport([]); } });
    const result = await provider.delegate(request());
    expect(spawned).toBe(true);
    if (result.status === "failed") expect(result.diagnostic.category).not.toBe("access-policy");
  });

  it("loads custom ACP agents and rejects duplicate ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-config-"));
    const configFile = join(dir, "agents.json");
    try {
      writeFileSync(configFile, JSON.stringify({ agents: [{ id: "custom", label: "Custom", protocol: "acp", binary: "agent", args: ["serve"] }] }));
      expect(createProviderFamilies({ homeDir: dir, configFile }).map((family) => family.id)).toContain("custom");
      writeFileSync(configFile, JSON.stringify({ agents: [{ id: "codex", label: "Duplicate", protocol: "acp", binary: "agent" }] }));
      expect(() => createProviderFamilies({ homeDir: dir, configFile })).toThrow(/重复/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("discovers an installed DeepSeek Harness desktop distribution for ACP", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-install-"));
    const root = join(home, "AppData", "Local", "Programs", "DeepSeek Harness");
    try {
      mkdirSync(join(root, "resources", "runtime", "cli", "bin"), { recursive: true });
      writeFileSync(join(root, "DeepSeek Harness.exe"), "");
      writeFileSync(join(root, "resources", "app.asar"), "");
      writeFileSync(join(root, "resources", "runtime", "cli", "bin", "dsh.cmd"), "");
      const family = createProviderFamilies({ homeDir: home, findInstalled: () => null }).find((item) => item.id === "deepseek-harness");
      expect(family).toBeDefined();
      expect(await family!.entries[0]!.provider.detect()).toMatchObject({ installed: true, binaryPath: join(root, "DeepSeek Harness.exe") });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("finds DeepSeek Harness in a custom install directory through the uninstall registry", async () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-custom-"));
    const custom = join(home, "SomewhereElse", "DSH");
    try {
      mkdirSync(join(custom, "resources", "runtime", "cli", "bin"), { recursive: true });
      writeFileSync(join(custom, "DeepSeek Harness.exe"), "");
      writeFileSync(join(custom, "resources", "app.asar"), "");
      writeFileSync(join(custom, "resources", "runtime", "cli", "bin", "dsh.cmd"), "");
      const family = createProviderFamilies({
        homeDir: home,
        findInstalled: (name) => (name === "DeepSeek Harness" ? join(custom, "DeepSeek Harness.exe") : null),
      }).find((item) => item.id === "deepseek-harness");
      expect(await family!.entries[0]!.provider.detect()).toMatchObject({ installed: true, binaryPath: join(custom, "DeepSeek Harness.exe") });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("sends a writable command task over stdin and collects stdout", async () => {
    const agent = new CommandProvider("example", process.execPath, ["-e", "process.stdin.on('data', x => process.stdout.write(x))"]);
    const result = await agent.delegate({ ...request(), mode: "write" });
    expect(result).toMatchObject({ status: "ok" });
    if (result.status === "ok") expect(result.answer).toContain("hello");
    expect(await agent.delegate(request())).toMatchObject({ status: "failed", diagnostic: { category: "access-policy" } });
  });

  it("initializes before reading current Codex history shapes", async () => {
    const transport = new FakeRpcTransport([
      { request: "initialize", response: {} },
      { request: "thread/read", response: { thread: { turns: [{ items: [{ type: "agentMessage", text: "historic answer" }] }] } } },
    ]);
    expect(await new CodexAppServerProvider({ createTransport: () => transport }).readSession("t1", { offset: 0, limit: 10 })).toEqual([{ type: "output", text: "agentMessage: historic answer" }]);
  });
});
