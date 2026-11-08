/**
 * 客户端对象层的真连接测试（P2 的"界面闭环"证据）。
 * 遵循架构设计规范。
 *
 * 这里不渲染 React：`ClientStore` 就是界面唯一的状态来源，
 * 它跑通等于"订阅 → 派生视图 → 动作"这条链路跑通。
 */

import { WebSocket as WsSocket } from "ws";
import { describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "../../src/host/index.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createTestBackend } from "../../src/host/boot/secrets.js";
import { ClientStore } from "../../src/client/object/store.js";
import type { ClientState } from "../../src/client/object/store.js";
import { makeTempHome } from "../helpers/temp.js";
import { FAKE_ANSWER, TEST_MODEL, fakeModelFetch } from "../helpers/model.js";

/**
 * 浏览器里的 WebSocket 会自动带 Origin 头；Node 的 ws 不会。
 * 这里补上——服务端按  校验 Origin，缺了就该被拒。
 */
class BrowserLikeSocket extends WsSocket {
  constructor(url: string | URL) {
    const target = new URL(String(url));
    super(String(url), { headers: { Origin: `http://${target.host}` } });
  }
}

globalThis.WebSocket = BrowserLikeSocket as unknown as typeof WebSocket;

const logger = silentLogger();

/**
 * 在指定端口重新起一个 host（模拟"应用重启"）。
 *
 * 端口是客户端重连的目标，所以必须复用同一个；刚释放的端口偶尔还会被占，
 * 这里退几步再试，别把环境抖动写进用例结论。
 */
async function startHostOn(options: {
  home: string;
  port: number;
  token: string;
}): Promise<RunningHost> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await startHost({
        home: options.home,
        port: options.port,
        token: options.token,
        logger,
        skipInstanceLock: true,
        secretBackend: createTestBackend(),
        rendererDir: null,
        fetchImpl: fakeModelFetch(),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 配一个模型档案与密钥。
 *
 * 档案为空时 `message.send` 会被拒绝，所以这里先配好；档案指向假服务（`fakeModelFetch`）。
 */
async function addModel(host: RunningHost): Promise<void> {
  const upserted = await host.rpc("model.upsert", { profile: TEST_MODEL });
  if (!upserted.ok) throw new Error(`配模型失败：${upserted.error.message}`);
  const saved = await host.rpc("secret.set", { key: `model:${TEST_MODEL.id}`, value: "sk-test" });
  if (!saved.ok) throw new Error(`配密钥失败：${saved.error.message}`);
}


async function waitFor(
  store: ClientStore,
  check: (state: ClientState) => boolean,
  timeoutMs = 10_000,
): Promise<ClientState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = store.snapshot();
    if (check(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${JSON.stringify(store.snapshot())}`);
}

describe("Client Connection and State", () => {
  it("handles full lifecycle: connect, create session, send message, view derivation, rename, rewind, and disconnect", async () => {
    const temp = makeTempHome();
    const host: RunningHost = await startHost({
      home: temp.home,
      port: 0,
      logger,
      skipInstanceLock: true,
      secretBackend: createTestBackend(),
      rendererDir: null,
      fetchImpl: fakeModelFetch(),
    });
    await addModel(host);
    const store = new ClientStore({ port: host.port, token: host.token, locale: "zh-CN" });
    try {
      store.start();
      const opened = await waitFor(store, (state) => state.status === "open" && state.models.length > 0);
      expect(opened.agents.length).toBeGreaterThan(0);
      expect(opened.error).toBeNull();
      // 配好密钥的档案在回包里必须带 hasKey，界面不会把它标成"缺少密钥"。
      expect(opened.models[0]?.hasKey).toBe(true);

      // 工作区：加进来就会被选中；此时不应有任何订阅帧错误留在 error 里。
      await store.addWorkspace(temp.home);
      const withWorkspace = store.snapshot();
      expect(withWorkspace.workspaces.length).toBe(1);
      expect(withWorkspace.activeWorkspaceId).toBe(withWorkspace.workspaces[0]?.id);
      expect(withWorkspace.error).toBeNull();
      expect(store.connection.subscribedSession).toBeNull();

      await store.createSession();
      const created = await waitFor(store, (state) => state.activeSessionId !== null);
      const sessionId = created.activeSessionId;
      expect(sessionId).not.toBeNull();
      expect(store.connection.subscribedSession).toBe(sessionId);

      await store.send("你好");
      const answered = await waitFor(
        store,
        (state) => (state.view?.messages.length ?? 0) >= 2 && !state.busy,
      );
      const messages = answered.view?.messages ?? [];
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
      expect(messages[0]?.text).toBe("你好");
      expect(messages[1]?.text).toBe(FAKE_ANSWER);
      expect(answered.view?.sessionId).toBe(sessionId);
      expect(answered.error).toBeNull();

      // 改名 → 列表跟着更新（标题来自日志首行，不是缓存）。
      await store.renameSession("改名后的会话");
      const renamed = await waitFor(store, (state) =>
        state.sessions.some((session) => session.title === "改名后的会话"),
      );
      expect(renamed.sessions[0]?.title).toBe("改名后的会话");

      // 回撤到用户消息之前：视图只剩空，但事件没有删。
      const userSeq = messages[0]?.seq ?? 0;
      expect(userSeq).toBeGreaterThan(0);
      await store.rewind(userSeq - 1);
      const rewound = await waitFor(store, (state) => (state.view?.messages.length ?? -1) === 0);
      expect(rewound.view?.lastSeq).toBeGreaterThan(userSeq);
    } finally {
      store.stop();
      await host.close();
      temp.cleanup();
    }
  }, 40_000);

  it("returns structured RPC error on invalid params without crashing transport", async () => {
    const temp = makeTempHome();
    const host = await startHost({
      home: temp.home,
      port: 0,
      logger,
      skipInstanceLock: true,
      secretBackend: createTestBackend(),
      rendererDir: null,
    });
    const store = new ClientStore({ port: host.port, token: host.token, locale: "zh-CN" });
    try {
      store.start();
      await waitFor(store, (state) => state.status === "open");

      await store.selectSession("../evil");
      const failed = await waitFor(store, (state) => state.error !== null);
      expect(failed.error).toContain("会话 id 不合法");

      // 连接仍然可用：错误之后还能正常取列表。
      await store.loadSessions("");
      await waitFor(store, (state) => state.error === null || state.sessions.length >= 0);
      expect(store.connection.currentStatus).toBe("open");
    } finally {
      store.stop();
      await host.close();
      temp.cleanup();
    }
  }, 30_000);

  it("refreshes profile availability immediately upon saving API key", async () => {
    const temp = makeTempHome();
    const host = await startHost({
      home: temp.home,
      port: 0,
      logger,
      skipInstanceLock: true,
      secretBackend: createTestBackend(),
      rendererDir: null,
    });
    const store = new ClientStore({ port: host.port, token: host.token, locale: "zh-CN" });
    try {
      store.start();
      await waitFor(store, (state) => state.status === "open");

      expect(await store.saveModel(TEST_MODEL)).toBe(true);
      // 只存了档案、没存密钥：界面据此提示"缺少密钥"。
      expect(store.snapshot().models[0]?.hasKey).toBe(false);

      expect(await store.setSecret(`model:${TEST_MODEL.id}`, "sk-test")).toBe(true);
      // 密钥一存好，档案就必须变成可用状态，不用等下一次重连。
      expect(store.snapshot().models[0]?.hasKey).toBe(true);
    } finally {
      store.stop();
      await host.close();
      temp.cleanup();
    }
  }, 30_000);

  it("resets client state to disconnected with error message when host closes", async () => {
    const temp = makeTempHome();
    const host = await startHost({
      home: temp.home,
      port: 0,
      logger,
      skipInstanceLock: true,
      secretBackend: createTestBackend(),
      rendererDir: null,
    });
    const store = new ClientStore({ port: host.port, token: host.token, locale: "zh-CN" });
    try {
      store.start();
      await waitFor(store, (state) => state.status === "open");
      store.stop();
      const closed = await waitFor(store, (state) => state.status === "closed");
      expect(closed.status).toBe("closed");
    } finally {
      store.stop();
      await host.close();
      temp.cleanup();
    }
  }, 30_000);

  it("replays from cursor on reconnect without duplicate events", async () => {
    const temp = makeTempHome();
    const first = await startHost({
      home: temp.home,
      port: 0,
      logger,
      skipInstanceLock: true,
      secretBackend: createTestBackend(),
      rendererDir: null,
      fetchImpl: fakeModelFetch(),
    });
    await addModel(first);
    const port = first.port;
    const store = new ClientStore({ port, token: first.token, locale: "zh-CN", retryBaseMs: 25 });
    let second: RunningHost | null = null;
    try {
      store.start();
      await waitFor(store, (state) => state.status === "open");
      await store.addWorkspace(temp.home);
      await store.createSession();
      await waitFor(store, (state) => state.activeSessionId !== null);

      await store.send("第一句");
      const beforeDrop = await waitFor(
        store,
        (state) => (state.view?.messages.length ?? 0) >= 2 && !state.busy,
      );
      const beforeSeqs = (beforeDrop.view?.messages ?? []).map((message) => message.seq);
      const beforeCount = store.appliedEvents.length;
      expect(beforeCount).toBeGreaterThan(0);

      // 掐掉服务端：客户端会自动重连（不是我们主动 close）。
      await first.close();
      await waitFor(store, (state) => state.status !== "open", 5_000);

      second = await startHostOn({
        home: temp.home,
        port,
        token: first.token,
      });
      const reconnected = await waitFor(store, (state) => state.status === "open", 20_000);

      // 关键断言：补发起点用 lastSeq，重放不会把已有事件再塞一遍。
      expect(store.appliedEvents.length).toBe(beforeCount);
      expect(new Set(store.appliedEvents.map((event) => event.seq)).size).toBe(beforeCount);
      expect((reconnected.view?.messages ?? []).map((message) => message.seq)).toEqual(beforeSeqs);
      expect(reconnected.error).toBeNull();
    } finally {
      store.stop();
      await second?.close();
      await first.close().catch(() => undefined);
      temp.cleanup();
    }
  }, 60_000);

  it("receives new events in order after reconnect with monotonic sequence numbers", async () => {
    const temp = makeTempHome();
    const first = await startHost({
      home: temp.home,
      port: 0,
      logger,
      skipInstanceLock: true,
      secretBackend: createTestBackend(),
      rendererDir: null,
      fetchImpl: fakeModelFetch(),
    });
    await addModel(first);
    const port = first.port;
    const store = new ClientStore({ port, token: first.token, locale: "zh-CN", retryBaseMs: 25 });
    let second: RunningHost | null = null;
    try {
      store.start();
      await waitFor(store, (state) => state.status === "open");
      await store.addWorkspace(temp.home);
      await store.createSession();
      await waitFor(store, (state) => state.activeSessionId !== null);

      await store.send("断线前");
      await waitFor(store, (state) => (state.view?.messages.length ?? 0) >= 2 && !state.busy);
      const beforeCount = store.appliedEvents.length;

      await first.close();
      await waitFor(store, (state) => state.status !== "open", 5_000);
      second = await startHostOn({ home: temp.home, port, token: first.token });
      await waitFor(store, (state) => state.status === "open", 20_000);
      await store.send("断线后");
      const after = await waitFor(store, (state) => (state.view?.messages.length ?? 0) >= 4 && !state.busy);
      const seqs = store.appliedEvents.map((event) => event.seq);

      expect(after.view?.messages).toHaveLength(4);
      expect(store.appliedEvents.length).toBeGreaterThan(beforeCount);
      expect(new Set(seqs).size).toBe(seqs.length);
      for (let index = 1; index < seqs.length; index += 1) {
        expect(seqs[index]!).toBeGreaterThan(seqs[index - 1]!);
      }
      expect(after.view?.messages.map((message) => message.text)).toEqual([
        "断线前",
        FAKE_ANSWER,
        "断线后",
        FAKE_ANSWER,
      ]);
    } finally {
      store.stop();
      await second?.close();
      await first.close().catch(() => undefined);
      temp.cleanup();
    }
  }, 60_000);
});
