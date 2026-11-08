/**
 * P2/内置工具与调度：从 RPC 到日志再到界面视图的整条链路。
 * 端到端集成测试：日志持久化与重启恢复。
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "../../src/host/index.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createTestBackend } from "../../src/host/boot/secrets.js";
import { sessionIndexFile, sessionLogFile } from "../../src/host/boot/paths.js";
import type { RpcResponse } from "../../src/shared/protocol/rpc.js";
import { deriveView } from "../../src/shared/session/derive.js";
import { parseSessionEvent, type SessionEvent } from "../../src/shared/session/events.js";
import { makeTempHome } from "../helpers/temp.js";
import { FAKE_ANSWER, TEST_MODEL, fakeModelFetch } from "../helpers/model.js";

const logger = silentLogger();

function ok<T>(response: RpcResponse): T {
  if (!response.ok) throw new Error(`RPC 失败：${response.error.code} ${response.error.message}`);
  return response.result as T;
}

async function boot(home: string): Promise<RunningHost> {
  return await startHost({
    home,
    port: 0,
    logger,
    skipInstanceLock: true,
    secretBackend: createTestBackend(),
    rendererDir: null,
    fetchImpl: fakeModelFetch(),
  });
}

/**
 * 配一个模型档案与密钥。
 *
 * `message.send` 在没有档案时会拒绝，所以发送前必须先配好；档案指向 `fakeModelFetch`，
 * settings、secrets、真实客户端都按正常路径走。
 */
async function addModel(host: RunningHost): Promise<void> {
  ok(await host.rpc("model.upsert", { profile: TEST_MODEL }));
  ok(await host.rpc("secret.set", { key: `model:${TEST_MODEL.id}`, value: "sk-test" }));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待超时");
}

interface SessionRow {
  readonly sessionId: string;
  readonly title: string;
  readonly counts: { readonly user: number; readonly assistant: number };
}

describe("processes user turn and persists structured session events end-to-end", () => {
  it("send message, model response, readable log, restart recovery, and rewind", async () => {
    const temp = makeTempHome();
    let host = await boot(temp.home);
    try {
      await addModel(host);
      const workspace = ok<{ id: string }>(
        await host.rpc("workspace.add", { path: temp.home }),
      );
      const created = ok<{ sessionId: string }>(
        await host.rpc("session.create", { workspaceId: workspace.id, title: "第一句话" }),
      );
      const sent = ok<{ turnId: string }>(
        await host.rpc("message.send", { sessionId: created.sessionId, text: "你好" }),
      );
      expect(sent.turnId).not.toBe("");

      const oneAnswer = async (): Promise<boolean> => {
        const rows = ok<SessionRow[]>(await host.rpc("session.list", { workspaceId: workspace.id }));
        const row = rows.find((candidate) => candidate.sessionId === created.sessionId);
        return row !== undefined && row.counts.assistant >= 1;
      };
      await waitFor(oneAnswer);

      // 日志本身：首行是头，序号连续，事件顺序符合 。
      const logFile = sessionLogFile(host.paths, created.sessionId);
      const lines = readFileSync(logFile, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      const header = lines[0] as { kind: string; fields: string[]; meta: { title: string } };
      expect(header.kind).toBe("header");
      expect(header.fields).toContain("text");
      expect(header.meta.title).toBe("第一句话");

      const events = lines.slice(1) as Array<{ seq: number; type: string; text?: string }>;
      expect(events.map((event) => event.type)).toEqual([
        "turn/start",
        "user/message",
        "request/header",
        "assistant/message",
        "turn/end",
      ]);
      expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(events[1]?.text).toBe("你好");
      expect(events[3]?.text).toBe(FAKE_ANSWER);

      // 界面视图：客户端与服务端共用同一份派生代码，这里直接用它算。
      const eventsOf = (): SessionEvent[] =>
        readFileSync(logFile, "utf8")
          .trimEnd()
          .split("\n")
          .slice(1)
          .map((line) => {
            const parsed = parseSessionEvent(JSON.parse(line));
            if (!parsed.ok) throw new Error(parsed.issue);
            return parsed.value;
          })
          .filter((event): event is SessionEvent => event !== null);
      const ctx = {
        sessionId: created.sessionId,
        workspaceId: workspace.id,
        workspace: temp.home,
      } as const;
      const view = deriveView(eventsOf(), ctx);
      expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(view.messages[0]?.seq).toBe(2);
      expect(view.messages[1]?.seq).toBe(4);

      // 删掉索引缓存，标题与计数仍然在。
      const indexFile = sessionIndexFile(host.paths, created.sessionId);
      if (existsSync(indexFile)) rmSync(indexFile);
      await host.close();

      host = await boot(temp.home);
      const reopened = ok<SessionRow[]>(await host.rpc("session.list", { workspaceId: workspace.id }));
      const row = reopened.find((candidate) => candidate.sessionId === created.sessionId);
      expect(row?.title).toBe("第一句话");
      expect(row?.counts.assistant).toBe(1);

      // 回退到用户消息之前：中间区间被隐藏，但事件仍然在日志里。
      ok(await host.rpc("message.rewind", { sessionId: created.sessionId, toSeq: 1 }));
      expect(deriveView(eventsOf(), ctx).messages).toHaveLength(0);
      const afterLines = readFileSync(logFile, "utf8").trimEnd().split("\n");
      expect(afterLines.length).toBeGreaterThan(lines.length);
      expect(afterLines.at(-1)).toContain("rewind");
    } finally {
      await host.close();
      temp.cleanup();
    }
  }, 30_000);

  it("returns busy status when receiving request while turn is active", async () => {
    const temp = makeTempHome();
    const host = await boot(temp.home);
    try {
      await addModel(host);
      const workspace = ok<{ id: string }>(await host.rpc("workspace.add", { path: temp.home }));
      const session = ok<{ sessionId: string }>(
        await host.rpc("session.create", { workspaceId: workspace.id, title: "并发" }),
      );
      ok(await host.rpc("message.send", { sessionId: session.sessionId, text: "第一条" }));
      const second = await host.rpc("message.send", { sessionId: session.sessionId, text: "第二条" });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.code).toBe("busy");

      await waitFor(async () => {
        const rows = ok<SessionRow[]>(await host.rpc("session.list", { workspaceId: workspace.id }));
        return (rows[0]?.counts.assistant ?? 0) >= 1;
      });
    } finally {
      await host.close();
      temp.cleanup();
    }
  }, 20_000);

  it("single session directory is exclusive writer ensuring duplicate names do not collide", async () => {
    const temp = makeTempHome();
    const host = await boot(temp.home);
    try {
      const workspace = ok<{ id: string }>(await host.rpc("workspace.add", { path: temp.home }));
      const first = ok<{ sessionId: string }>(
        await host.rpc("session.create", { workspaceId: workspace.id, title: "同名" }),
      );
      const second = ok<{ sessionId: string }>(
        await host.rpc("session.create", { workspaceId: workspace.id, title: "同名" }),
      );
      expect(first.sessionId).not.toBe(second.sessionId);
      ok(await host.rpc("session.rename", { sessionId: second.sessionId, title: "改过的标题" }));
      const rows = ok<SessionRow[]>(await host.rpc("session.list", { workspaceId: workspace.id }));
      expect(rows.map((row) => row.title).sort()).toEqual(["同名", "改过的标题"]);
      expect(existsSync(join(host.paths.sessionsDir, second.sessionId))).toBe(true);
    } finally {
      await host.close();
      temp.cleanup();
    }
  }, 20_000);
});
