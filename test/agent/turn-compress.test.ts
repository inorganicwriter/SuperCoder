/**
 * 回合内的上下文压缩：用到窗口 80% 时先让当前模型写摘要，再继续这一步。
 */

import { describe, expect, it } from "vitest";
import type { LlmChunk, LlmClient, LlmRequest } from "../../src/host/models/llm.js";
import { ModelCatalog } from "../../src/host/models/catalog.js";
import { TEST_MODEL } from "../helpers/model.js";
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

/** 收到摘要指令就回摘要，否则正常回答；记下每次请求。 */
class RecordingClient implements LlmClient {
  readonly id = "recording";
  readonly requests: LlmRequest[] = [];

  async *stream(request: LlmRequest): AsyncGenerator<LlmChunk> {
    this.requests.push(request);
    const isSummary = request.messages[0]?.content.startsWith("Summarize the conversation") === true;
    yield { type: "text", text: isSummary ? "- 早先：讨论了方案甲" : "好的" };
    yield { type: "done" };
  }
}

describe("In-Turn Context Compression", () => {
  it("emits summary event when exceeding 80% window and retains summary with recent messages", async () => {
    const home = makeTempHome();
    const store = new SessionStore({ paths: home.paths, logger });
    try {
      const session = store.get(store.create("ws1", "压缩").sessionId);
      // 先放几轮较长的对话，让上下文明显超过 200 token 的 80%。
      for (let round = 0; round < 4; round += 1) {
        session.append("user/message", { text: `第${String(round)}轮：${"方案甲的细节".repeat(12)}`, attachments: [] });
        session.append("assistant/message", { step: 0, text: `回复${String(round)}：${"已经记下".repeat(12)}` });
      }
      const models = new ModelCatalog({ settings: new SettingsStore(home.paths), secrets: new SecretStore(home.paths.secretsFile, createTestBackend()) });
      const client = new RecordingClient();
      models.clientFor = (): LlmClient => client;
      models.get = () => ({ ...TEST_MODEL, contextWindow: 200 });
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
      });

      await runner.run({ session, turnId: "t1", text: "继续", attachments: [], modelId: TEST_MODEL.id, signal: new AbortController().signal });

      const summaries = session.allEvents().filter((event) => event.type === "context/summary");
      expect(summaries).toHaveLength(1);
      const main = client.requests.at(-1)!;
      const contents = main.messages.map((message) => message.content);
      expect(contents.some((text) => text.includes("- 早先：讨论了方案甲"))).toBe(true);
      expect(contents.some((text) => text.startsWith("第0轮"))).toBe(false);
      expect(contents).toContain("继续");
    } finally {
      store.closeAll();
      home.cleanup();
    }
  });
});
