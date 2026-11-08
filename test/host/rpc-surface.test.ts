/**
 * RPC 远程调用接口完整性与权限策略验证。
 *
 * 已经别处覆盖的（消息、回撤、任务分派、审批、提问）这里不重复；
 * 这里盯的是设置类与资源类：模型档案、MCP、密钥、诊断包、重建索引、删除会话。
 * `assertFullCoverage` 保证"方法都注册了"，这些用例保证"注册的能真用"。
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
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
      expect(registered).toHaveLength(39);
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
