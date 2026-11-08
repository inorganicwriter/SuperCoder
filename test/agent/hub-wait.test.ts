/**
 * `waitTurn` 的返回语义。遵循架构设计规范。
 *
 * 查不到的回合不能返回 "completed"：那是编造成功。调用方（诊断、测试、
 * 将来任何"等这个回合跑完"的代码）会以为对话已经正常结束，而实际上什么都没有跑过。
 */

import { describe, expect, it } from "vitest";
import type { LlmChunk, LlmClient, LlmRequest } from "../../src/host/models/llm.js";
import { ModelCatalog } from "../../src/host/models/catalog.js";
import { TEST_MODEL, seedModel } from "../helpers/model.js";
import { SettingsStore } from "../../src/host/boot/config.js";
import { SecretStore, createTestBackend } from "../../src/host/boot/secrets.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { isRpcFailure } from "../../src/host/boot/failure.js";
import { SessionStore } from "../../src/host/session/store.js";
import { ApprovalBroker } from "../../src/host/tools/approval.js";
import { ToolRegistry } from "../../src/host/tools/registry.js";
import { ToolPipeline } from "../../src/host/tools/pipeline.js";
import { QuestionBroker } from "../../src/host/agent/questions.js";
import { AgentHub } from "../../src/host/agent/hub.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

class OneShotClient implements LlmClient {
  readonly id = "one-shot";

  async *stream(_request: LlmRequest): AsyncGenerator<LlmChunk> {
    yield { type: "text", text: "好" };
    yield { type: "done" };
  }
}

function setup() {
  const home = makeTempHome();
  const store = new SessionStore({ paths: home.paths, logger });
  const session = store.get(store.create("ws1", "等待回合").sessionId);
  const settings = new SettingsStore(home.paths);
  seedModel(settings);
  const secrets = new SecretStore(home.paths.secretsFile, createTestBackend());
  const models = new ModelCatalog({ settings, secrets });
  models.clientFor = (): LlmClient => new OneShotClient();
  const registry = new ToolRegistry();
  const approvals = new ApprovalBroker(logger);
  const tools = new ToolPipeline({ registry, approvals, policy: () => "never", logger });
  const hub = new AgentHub({
    models,
    tools,
    registry,
    approvals,
    questions: new QuestionBroker(logger),
    logger,
    language: () => "zh-CN",
    workspacePathOf: () => home.home,
    maxSteps: 2,
  });
  return {
    hub,
    session,
    cleanup: () => {
      hub.shutdown();
      store.closeAll();
      home.cleanup();
    },
  };
}

describe("waitTurn Turn Awaiting", () => {
  it("returns not_found for non-existent turn without fabricating completion", async () => {
    const fixture = setup();
    try {
      let caught: unknown = null;
      try {
        await fixture.hub.waitTurn("turn_nope");
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeNull();
      expect(isRpcFailure(caught)).toBe(true);
      if (isRpcFailure(caught)) {
        expect(caught.code).toBe("not_found");
        expect(caught.message).toContain("未找到正在执行的回合");
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("returns actual completion status for finished turns", async () => {
    const fixture = setup();
    try {
      const { turnId } = fixture.hub.send({
        session: fixture.session,
        text: "说句话",
        attachments: [],
        modelId: TEST_MODEL.id,
      });
      const status = await fixture.hub.waitTurn(turnId);
      expect(status).toBe("completed");
      // 跑完之后就不再挂着：再问一次必须是 not_found，而不是又给一个 completed。
      let caught: unknown = null;
      try {
        await fixture.hub.waitTurn(turnId);
      } catch (error) {
        caught = error;
      }
      expect(isRpcFailure(caught) && caught.code === "not_found").toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
