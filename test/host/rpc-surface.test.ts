/**
 * RPC 远程调用接口完整性与权限策略验证。
 *
 * 已经别处覆盖的（消息、回撤、任务分派、审批、提问）这里不重复；
 * 这里盯的是设置类与资源类：模型档案、MCP、密钥、诊断包、重建索引、删除会话。
 * `assertFullCoverage` 保证"方法都注册了"，这些用例保证"注册的能真用"。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "../../src/host/index.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createTestBackend } from "../../src/host/boot/secrets.js";
import { METHODS, type MethodName, type MethodParams, type MethodResult } from "../../src/shared/protocol/methods.js";
import type { ErrorCode } from "../../src/shared/protocol/errors.js";
import { makeTempHome } from "../helpers/temp.js";
import { TEST_MODEL, fakeModelFetch } from "../helpers/model.js";

const logger = silentLogger();

interface Fixture {
  readonly host: RunningHost;
  readonly home: string;
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  errorOf<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
  ): Promise<{ code: ErrorCode; message: string }>;
  cleanup(): Promise<void>;
}

async function boot(): Promise<Fixture> {
  const temp = makeTempHome();
  const host = await startHost({
    home: temp.home,
    port: 0,
    logger,
    skipInstanceLock: true,
    secretBackend: createTestBackend(),
    rendererDir: null,
    fetchImpl: fakeModelFetch(),
  });
  const call = async <M extends MethodName>(method: M, params: MethodParams<M>) => {
    const frame = await host.rpc(method, params);
    if (frame.kind !== "result" || !frame.ok) {
      throw new Error(`期望成功，实际失败：${JSON.stringify(frame)}`);
    }
    return frame.result as MethodResult<M>;
  };
  const errorOf = async <M extends MethodName>(method: M, params: MethodParams<M>) => {
    const frame = await host.rpc(method, params);
    if (frame.kind !== "result" || frame.ok) {
      throw new Error(`期望失败，实际成功：${JSON.stringify(frame)}`);
    }
    return frame.error;
  };
  return {
    host,
    home: temp.home,
    call,
    errorOf,
    cleanup: async () => {
      await host.close();
      temp.cleanup();
    },
  };
}

describe("RPC Callable Surface", () => {
  it("covers all registered RPC methods completely on startup", async () => {
    const fixture = await boot();
    try {
      const registered = fixture.host.router.methods().sort();
      expect(registered).toEqual(Object.keys(METHODS).sort());
      expect(registered).toHaveLength(50);
    } finally {
      await fixture.cleanup();
    }
  });

  it("persists and clears each agent's native model ID", async () => {
    const fixture = await boot();
    try {
      await fixture.call("agent.model.set", { agentId: "codex", model: "example-model" });
      const saved = JSON.parse(readFileSync(join(fixture.home, "agent-models.json"), "utf8")) as Record<string, string>;
      expect(saved.codex).toBe("example-model");
      await fixture.call("agent.model.set", { agentId: "codex", model: null });
      expect(JSON.parse(readFileSync(join(fixture.home, "agent-models.json"), "utf8"))).toEqual({});
      const error = await fixture.errorOf("agent.model.set", { agentId: "unknown", model: "x" });
      expect(error.code).toBe("invalid_params");
    } finally { await fixture.cleanup(); }
  });

  it("stores only the profile reference when an agent uses a SuperCoder API model", async () => {
    const fixture = await boot();
    try {
      await fixture.call("model.upsert", { profile: { id: "custom", label: "Custom", kind: "openai-compatible", baseUrl: "https://example.test/v1", model: "custom-model", structuredOutput: "none", default: false } });
      await fixture.call("secret.set", { key: "model:custom", value: "test-private-key" });
      await fixture.call("agent.model.set", { agentId: "opencode", model: "profile:custom" });
      await fixture.call("agent.model.set", { agentId: "deepseek-harness", model: "profile:custom" });
      const saved = readFileSync(join(fixture.home, "agent-models.json"), "utf8");
      expect(saved).toContain("profile:custom");
      expect(saved).toContain("deepseek-harness");
      expect(saved).not.toContain("test-private-key");
    } finally { await fixture.cleanup(); }
  });

  it("persists the ACP permission policy separately for each agent", async () => {
    const fixture = await boot();
    try {
      await fixture.call("agent.permission.set", { agentId: "antigravity", policy: "allow" });
      const agents = await fixture.call("agent.list", {});
      expect(agents.find((agent) => agent.id === "antigravity")?.permissionPolicy).toBe("allow");
      expect(agents.find((agent) => agent.id === "deepseek-harness")?.permissionPolicy).toBe("deny");
      await fixture.call("agent.permission.set", { agentId: "codex", policy: "allow" });
    } finally { await fixture.cleanup(); }
  });

  it("persists per-agent sandbox config with encrypted secrets and evaluates network tests", async () => {
    const fixture = await boot();
    try {
      const saved = await fixture.call("agent.sandbox.set", {
        agentId: "codex",
        sandbox: {
          network: {
            mode: "proxy",
            proxyUrl: "http://127.0.0.1:7890",
            noProxy: ["localhost"],
            allowlist: ["api.openai.com"],
            denylist: [],
          },
          env: {
            set: { CUSTOM_FLAG: "1", OPENAI_API_KEY: "sk-inline-secret" },
            secretKeys: [],
            unset: ["HTTP_PROXY"],
            prependPath: [],
            isolatedHome: false,
          },
          workspace: { isolation: "worktree" },
          backend: { kind: "process" },
        },
        secretValues: { CUSTOM_TOKEN: "tok-explicit-secret" },
      });

      expect(saved.network.mode).toBe("proxy");
      expect(saved.workspace.isolation).toBe("worktree");
      expect(saved.env.set).toEqual({ CUSTOM_FLAG: "1" });
      expect(saved.env.secretKeys).toEqual(["CUSTOM_TOKEN", "OPENAI_API_KEY"]);

      const rawSandboxFile = readFileSync(join(fixture.home, "agent-sandboxes.json"), "utf8");
      expect(rawSandboxFile).not.toContain("sk-inline-secret");
      expect(rawSandboxFile).not.toContain("tok-explicit-secret");

      const agents = await fixture.call("agent.list", {});
      const codex = agents.find((a) => a.id === "codex");
      expect(codex?.sandbox?.network.mode).toBe("proxy");
      expect(codex?.sandbox?.workspace.isolation).toBe("worktree");
      expect(codex?.sandboxCapabilities?.network).toBe(true);

      const blocked = await fixture.call("agent.sandbox.test", {
        agentId: "codex",
        targetUrl: "https://blocked.example.com",
      });
      expect(blocked.ok).toBe(false);
      expect(blocked.blockedByRule).toBe(true);

      const offlineBlocked = await fixture.call("agent.sandbox.test", {
        agentId: "codex",
        targetUrl: "https://api.openai.com",
        sandbox: {
          network: { mode: "offline", noProxy: [], allowlist: [], denylist: [] },
          env: { set: {}, secretKeys: [], unset: [], prependPath: [], isolatedHome: false },
          workspace: { isolation: "shared" },
          backend: { kind: "process" },
        },
      });
      expect(offlineBlocked.ok).toBe(false);
      expect(offlineBlocked.blockedByRule).toBe(true);

      const workspace = await fixture.call("workspace.add", { path: fixture.home });
      const { sessionId } = await fixture.call("session.create", { workspaceId: workspace.id });
      const { sessionId: otherSessionId } = await fixture.call("session.create", { workspaceId: workspace.id });
      const wtErr = await fixture.errorOf("task.worktree.diff", { sessionId, taskId: "missing_task" });
      expect(wtErr.code).toBe("not_found");

      const wtDir = join(fixture.home, "worktrees", workspace.id);
      mkdirSync(wtDir, { recursive: true });
      writeFileSync(
        join(wtDir, "t_done.meta.json"),
        JSON.stringify({
          taskId: "t_done",
          sessionId,
          workspaceId: workspace.id,
          workspaceRoot: fixture.home,
          worktreePath: join(wtDir, "t_done"),
          branch: "supercoder/task/t_done",
          baseCommit: "0000000000000000000000000000000000000000",
          state: "merged",
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );
      const wrongSession = await fixture.errorOf("task.worktree.apply", { sessionId: otherSessionId, taskId: "t_done" });
      expect(wrongSession.code).toBe("not_found");
      const alreadyMerged = await fixture.errorOf("task.worktree.apply", { sessionId, taskId: "t_done" });
      expect(alreadyMerged.code).toBe("denied");

      // Part 2: agent.sandbox.allowHost 与 agent.custom.* 生命周期
      const allowedProfile = await fixture.call("agent.sandbox.allowHost", {
        agentId: "codex",
        host: "extra.example.com",
      });
      expect(allowedProfile.network.allowlist).toContain("extra.example.com");

      await fixture.call("agent.sandbox.set", {
        agentId: "claude-code",
        sandbox: {
          network: { mode: "offline", noProxy: [], allowlist: [], denylist: [] },
          env: { set: {}, secretKeys: [], unset: [], prependPath: [], isolatedHome: false },
          workspace: { isolation: "shared" },
          backend: { kind: "process" },
        },
      });
      const offlineErr = await fixture.errorOf("agent.sandbox.allowHost", {
        agentId: "claude-code",
        host: "api.anthropic.com",
      });
      expect(offlineErr.code).toBe("denied");

      const locked = await fixture.call("agent.sandbox.lockAllowlist", {
        agentId: "codex",
        hosts: ["api.openai.com", "cdn.openai.com"],
        merge: false,
      });
      expect(locked.network.allowlist).toEqual(["api.openai.com", "cdn.openai.com"]);

      const offlineLockErr = await fixture.errorOf("agent.sandbox.lockAllowlist", {
        agentId: "claude-code",
        hosts: ["api.anthropic.com"],
      });
      expect(offlineLockErr.code).toBe("denied");

      const dupErr = await fixture.errorOf("agent.custom.upsert", {
        agent: { id: "codex", label: "Dup", protocol: "acp", binary: "codex", args: [], enabled: true },
      });
      expect(dupErr.code).toBe("invalid_params");

      const customSaved = await fixture.call("agent.custom.upsert", {
        agent: { id: "custom-cli", label: "Custom CLI", protocol: "command", binary: "echo", args: ["hi"], enabled: true },
      });
      expect(customSaved.id).toBe("custom-cli");
      expect((await fixture.call("agent.custom.list", {})).map((a) => a.id)).toEqual(["custom-cli"]);
      expect((await fixture.call("agent.list", {})).some((a) => a.id === "custom-cli")).toBe(true);

      await fixture.call("agent.custom.remove", { id: "custom-cli" });
      expect(await fixture.call("agent.custom.list", {})).toEqual([]);
      expect((await fixture.call("agent.list", {})).some((a) => a.id === "custom-cli")).toBe(false);

      const cleanupRes = await fixture.call("system.sandbox.cleanup", { includeKeptWorktrees: false });
      expect(cleanupRes.worktreesRemoved).toBeGreaterThanOrEqual(0);
      expect(cleanupRes.containersRemoved).toBeGreaterThanOrEqual(0);
      expect(cleanupRes.tempDirsRemoved).toBeGreaterThanOrEqual(0);
    } finally {
      await fixture.cleanup();
    }
  });

  it("model profile lifecycle: upsert, list, test, and remove", async () => {
    const fixture = await boot();
    try {
      await fixture.call("model.upsert", {
        profile: {
          id: "deepseek",
          label: "DeepSeek",
          kind: "openai-compatible",
          baseUrl: "https://api.deepseek.com",
          model: "deepseek-chat",
          secretKey: "deepseek-key",
          structuredOutput: "json-schema",
          default: true,
        },
      });
      const listed = await fixture.call("model.list", {});
      const deepseek = listed.find((profile) => profile.id === "deepseek");
      expect(deepseek?.model).toBe("deepseek-chat");
      expect(deepseek?.default).toBe(true);
      // 只填了键名、没存密钥：回包要说清楚，界面才不会把它显示成可用。
      expect(deepseek?.hasKey).toBe(false);
      // 只有一个默认模型，且默认模型一定是被选中的那个。
      expect(listed.filter((profile) => profile.default)).toHaveLength(1);

      // 存了密钥之后同一个字段翻成 true。
      await fixture.call("secret.set", { key: "deepseek-key", value: "sk-deepseek" });
      expect((await fixture.call("model.list", {})).find((profile) => profile.id === "deepseek")?.hasKey).toBe(true);
      await fixture.call("secret.clear", { key: "deepseek-key" });

      // 没配密钥时 model.test 必须给出可执行提示，而不是假装成功。
      const tested = await fixture.call("model.test", { id: "deepseek" });
      expect(tested.ok).toBe(false);
      if (!tested.ok) expect(tested.message).toContain("密钥");

      await fixture.call("model.remove", { id: "deepseek" });
      const after = await fixture.call("model.list", {});
      // 删除后列表为空，没有内置档案补位。
      expect(after).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects message immediately without creating turn when no model profile exists", async () => {
    const fixture = await boot();
    try {
      const workspace = await fixture.call("workspace.add", { path: fixture.home });
      const { sessionId } = await fixture.call("session.create", { workspaceId: workspace.id });

      const error = await fixture.errorOf("message.send", { sessionId, text: "你好", attachments: [] });
      expect(error.code).toBe("denied");
      expect(error.message).toContain("模型");
      // 拒绝了就不该开回合：日志里只有头部那一行。
      const log = readFileSync(join(fixture.home, "sessions", sessionId, "log.jsonl"), "utf8").trim().split("\n");
      expect(log).toHaveLength(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("secret lifecycle: set, has, and clear without plaintext exposure", async () => {
    const fixture = await boot();
    try {
      expect((await fixture.call("secret.has", { key: "demo" })).has).toBe(false);
      expect(await fixture.call("secret.set", { key: "demo", value: "sk-plain-text" })).toEqual({});
      expect((await fixture.call("secret.has", { key: "demo" })).has).toBe(true);

      const secretsFile = join(fixture.home, "secrets.bin");
      expect(existsSync(secretsFile)).toBe(true);
      expect(readFileSync(secretsFile, "utf8")).not.toContain("sk-plain-text");

      expect(await fixture.call("secret.clear", { key: "demo" })).toEqual({});
      expect((await fixture.call("secret.has", { key: "demo" })).has).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });

  it("MCP server lifecycle: add, list, auth, and remove", async () => {
    const fixture = await boot();
    try {
      await fixture.call("mcp.add", {
        server: {
          id: "fs",
          label: "文件系统",
          transport: "stdio",
          target: "npx",
          args: ["-y", "server"],
          enabled: true,
        },
      });
      const listed = await fixture.call("mcp.list", {});
      expect(listed[0]?.id).toBe("fs");
      expect(listed[0]?.enabled).toBe(true);
      expect(listed[0]?.connected).toBeNull();

      expect(
        await fixture.call("mcp.add", {
          server: {
            id: "remote",
            label: "远端",
            transport: "http",
            target: "http://127.0.0.1:9/mcp",
            args: [],
            enabled: true,
          },
        }),
      ).toEqual({});
      // 端口 9 上什么都没有：拿不到授权元数据就必须报错，不能凭空编一个 URL。
      const authError = await fixture.errorOf("mcp.auth", { id: "remote" });
      expect(["provider_failed", "denied", "unsupported"]).toContain(authError.code);
      expect(authError.message).toMatch(/OAuth|元数据|连接/);

      await fixture.call("mcp.remove", { id: "remote" });
      await fixture.call("mcp.remove", { id: "fs" });
      expect(await fixture.call("mcp.list", {})).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("session lifecycle: create, rename, rebuild index, and delete", async () => {
    const fixture = await boot();
    try {
      const workspace = await fixture.call("workspace.add", { path: fixture.home });
      const { sessionId } = await fixture.call("session.create", { workspaceId: workspace.id });

      await fixture.call("session.rename", { sessionId, title: "改过的标题" });
      expect((await fixture.call("session.list", { workspaceId: workspace.id }))[0]?.title).toBe(
        "改过的标题",
      );

      // 索引是可以随时删掉的缓存：删了重建，结论不变。
      rmSync(join(fixture.home, "sessions", sessionId, "index.json"), { force: true });
      await fixture.call("session.rebuild", { sessionId });
      expect((await fixture.call("session.list", { workspaceId: workspace.id }))[0]?.title).toBe(
        "改过的标题",
      );

      await fixture.call("session.delete", { sessionId });
      expect(await fixture.call("session.list", { workspaceId: workspace.id })).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("diagnostics export contains reports and logs without plaintext secrets", async () => {
    const fixture = await boot();
    try {
      await fixture.call("secret.set", { key: "apiKey", value: "sk-must-not-leak" });
      // 发消息需要一个模型档案；这里指向假服务（见 helpers/model.ts）。
      await fixture.call("model.upsert", { profile: TEST_MODEL });
      await fixture.call("secret.set", { key: `model:${TEST_MODEL.id}`, value: "sk-model-test" });
      const workspace = await fixture.call("workspace.add", { path: fixture.home });
      const { sessionId } = await fixture.call("session.create", { workspaceId: workspace.id });
      await fixture.call("message.send", {
        sessionId,
        text: "写一条消息，让日志里有东西",
        attachments: [],
      });

      const exported = await fixture.call("diagnostics.export", { sessionId });
      expect(existsSync(exported.path)).toBe(true);
      const report = readFileSync(join(exported.path, "report.json"), "utf8");
      const log = readFileSync(join(exported.path, "session-log.jsonl"), "utf8");
      expect(report).toContain("supercoder");
      expect(log).toContain("user/message");
      expect(report).not.toContain("sk-must-not-leak");
      expect(log).not.toContain("sk-must-not-leak");

      // 不带 sessionId 也能导：只是不附会话日志。
      const bare = await fixture.call("diagnostics.export", {});
      expect(existsSync(bare.path)).toBe(true);
      expect(existsSync(join(bare.path, "session-log.jsonl"))).toBe(false);

      // 嵌套设置里的敏感字段递归脱敏，且导出总数超过 10 个时自动裁剪旧包。
      writeFileSync(
        join(fixture.home, "settings.json"),
        JSON.stringify({
          nested: { authToken: "secret-nested-value", headers: [{ apiKey: "secret-item-key" }] },
        }),
        "utf8",
      );
      const redactedExport = await fixture.call("diagnostics.export", {});
      const redactedReport = readFileSync(join(redactedExport.path, "report.json"), "utf8");
      expect(redactedReport).not.toContain("secret-nested-value");
      expect(redactedReport).not.toContain("secret-item-key");
      expect(redactedReport).toContain("[redacted]");
      for (let i = 0; i < 10; i += 1) {
        await fixture.call("diagnostics.export", {});
      }
      const deadline = Date.now() + 3000;
      while (readdirSync(join(fixture.home, "diagnostics")).length > 10 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(readdirSync(join(fixture.home, "diagnostics")).length).toBeLessThanOrEqual(10);
    } finally {
      await fixture.cleanup();
    }
  });

  it("error paths follow contracts: session ID validation, missing task, and inactive task", async () => {
    const fixture = await boot();
    try {
      const badSession = await fixture.errorOf("task.get", { sessionId: "../evil", taskId: "t" });
      expect(badSession.code).toBe("invalid_params");
      expect(badSession.message).toContain("会话 id 不合法");

      const workspace = await fixture.call("workspace.add", { path: fixture.home });
      const { sessionId } = await fixture.call("session.create", { workspaceId: workspace.id });

      const missing = await fixture.errorOf("task.get", { sessionId, taskId: "没有这个任务" });
      expect(missing.code).toBe("not_found");
      expect(missing.message).toContain("未找到指定任务");

      const notRunning = await fixture.errorOf("task.cancel", { sessionId, taskId: "没有这个任务" });
      expect(notRunning.code).toBe("not_found");
      expect(notRunning.message).toContain("没有在运行");
    } finally {
      await fixture.cleanup();
    }
  });
});
