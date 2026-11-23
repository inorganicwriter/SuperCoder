/**
 * 回合的重试边界。遵循架构设计规范（模型输出超长 → 显式失败并重试一次）、C6。
 *
 * 重试只能发生一次，而且必须沿用同一个 step：
 * 早期实现用 `step -= 1` 抵消 for 的自增，只要模型持续返回 retryable，
 * 回合就永远不结束（turn/end 不写、会话永久 busy、日志无限增长）。
 */

import { describe, expect, it } from "vitest";
import type { LlmChunk, LlmClient, LlmRequest } from "../../src/host/models/llm.js";
import { ModelCatalog } from "../../src/host/models/catalog.js";
import { TEST_MODEL, seedModel } from "../helpers/model.js";
import { SettingsStore } from "../../src/host/boot/config.js";
import { SecretStore, createTestBackend } from "../../src/host/boot/secrets.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { SessionStore } from "../../src/host/session/store.js";
import { ApprovalBroker } from "../../src/host/tools/approval.js";
import { ToolRegistry } from "../../src/host/tools/registry.js";
import { ToolPipeline } from "../../src/host/tools/pipeline.js";
import { TurnRunner } from "../../src/host/agent/turn.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

/** 永远失败的模型客户端：调用次数超过上限就抛错，避免用例自己挂住。 */
class AlwaysFailingClient implements LlmClient {
  readonly id = "always-failing";
  calls = 0;
  readonly requests: LlmRequest[] = [];

  constructor(
    private readonly retryable: boolean,
    private readonly limit = 20,
  ) {}

  async *stream(request: LlmRequest): AsyncGenerator<LlmChunk> {
    this.requests.push(request);
    this.calls += 1;
    if (this.calls > this.limit) {
      throw new Error(`模型调用次数超过上限 ${String(this.limit)}：回合没有结束`);
    }
    yield { type: "error", message: "boom", retryable: this.retryable };
  }
}

function setup(retryable: boolean) {
  const home = makeTempHome();
  const store = new SessionStore({ paths: home.paths, logger });
  const sessionId = store.create("ws1", "重试测试").sessionId;
  const session = store.get(sessionId);

  const settings = new SettingsStore(home.paths);
  seedModel(settings);
  const secrets = new SecretStore(home.paths.secretsFile, createTestBackend());
  const models = new ModelCatalog({ settings, secrets });
  const client = new AlwaysFailingClient(retryable);
  // 只替换"建客户端"这一处：其余（档案解析、默认模型）仍走真实实现。
  models.clientFor = (): LlmClient => client;

  const registry = new ToolRegistry();
  const approvals = new ApprovalBroker(logger);
  const pipeline = new ToolPipeline({ registry, approvals, policy: () => "never", logger });

  const runner = new TurnRunner({
    models,
    tools: pipeline,
    registry,
    approvals,
    logger,
    language: () => "zh-CN",
    workspacePath: () => home.home,
    maxSteps: 8,
  });

  return {
    client,
    session,
    runner,
    cleanup: () => {
      store.closeAll();
      home.cleanup();
    },
  };
}

describe("Turn Retry Mechanism", () => {
  it("retries retryable errors at most once and finishes turn gracefully", async () => {
    const fixture = setup(true);
    try {
      const status = await fixture.runner.run({
        session: fixture.session,
        turnId: "turn_1",
        text: "做点事",
        attachments: [],
        modelId: TEST_MODEL.id,
        signal: new AbortController().signal,
      });

      expect(fixture.client.calls).toBe(2);
      const events = fixture.session.allEvents();
      const ends = events.filter((event) => event.type === "turn/end");
      expect(ends).toHaveLength(1);
      expect(ends[0]?.type === "turn/end" ? ends[0].reason : undefined).toBe("model_error");
      expect(status).toBe("completed");
      // 重试沿用同一个 step，而不是往后排一步。
      const steps = events
        .filter((event) => event.type === "request/header")
        .map((event) => (event.type === "request/header" ? event.step : -1));
      expect(steps).toEqual([0, 0]);
      // 两次尝试都记了账，且重试过程不会把临时提示写进模型上下文。
      expect(events.filter((event) => event.type === "assistant/attempt")).toHaveLength(2);
      const retryMessages = fixture.client.requests[1]?.messages ?? [];
      expect(retryMessages.some((m) => m.content.includes("正在重试一次"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("appends explicit notice and sets reason=max_steps when step limit is reached", async () => {
    const home = makeTempHome();
    const store = new SessionStore({ paths: home.paths, logger });
    const session = store.get(store.create("ws1", "步数上限").sessionId);
    const settings = new SettingsStore(home.paths);
    seedModel(settings);
    const secrets = new SecretStore(home.paths.secretsFile, createTestBackend());
    const models = new ModelCatalog({ settings, secrets });
    const loopingClient: LlmClient = {
      id: "loop",
      async *stream(): AsyncGenerator<LlmChunk> {
        yield {
          type: "tool-call",
          call: { id: "c1", name: "missing_tool", arguments: "{}" },
        };
        yield { type: "done" };
      },
    };
    models.clientFor = (): LlmClient => loopingClient;
    const registry = new ToolRegistry();
    const approvals = new ApprovalBroker(logger);
    const runner = new TurnRunner({
      models,
      tools: new ToolPipeline({ registry, approvals, policy: () => "never", logger }),
      registry,
      approvals,
      logger,
      language: () => "zh-CN",
      workspacePath: () => home.home,
      maxSteps: 2,
    });
    try {
      const status = await runner.run({
        session,
        turnId: "turn_max",
        text: "一直调工具",
        attachments: [],
        modelId: TEST_MODEL.id,
        signal: new AbortController().signal,
      });
      expect(status).toBe("completed");
      const events = session.allEvents();
      const end = events.find((e) => e.type === "turn/end");
      expect(end).toMatchObject({ type: "turn/end", status: "completed", reason: "max_steps" });
      const lastMsg = events.filter((e) => e.type === "assistant/message").at(-1);
      expect(lastMsg?.type === "assistant/message" ? lastMsg.text : "").toContain("最大工具调用步数上限");
    } finally {
      store.closeAll();
      home.cleanup();
    }
  });

  it("terminates immediately on non-retryable errors", async () => {
    const fixture = setup(false);
    try {
      const status = await fixture.runner.run({
        session: fixture.session,
        turnId: "turn_1",
        text: "做点事",
        attachments: [],
        modelId: TEST_MODEL.id,
        signal: new AbortController().signal,
      });
      expect(fixture.client.calls).toBe(1);
      const events = fixture.session.allEvents();
      expect(events.filter((event) => event.type === "turn/end")).toHaveLength(1);
      expect(events.filter((event) => event.type === "assistant/attempt")).toHaveLength(1);
      const steps = events
        .filter((event) => event.type === "request/header")
        .map((event) => (event.type === "request/header" ? event.step : -1));
      expect(steps).toEqual([0]);
      expect(status).toBe("completed");
    } finally {
      fixture.cleanup();
    }
  });
});
