/**
 * 通道测试脚手架：起一个真的 http+ws，用真的 token 跑一轮。
 */

import { WebSocket } from "ws";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createToken } from "../../src/host/channel/auth.js";
import { SubscriptionHub } from "../../src/host/channel/events.js";
import { RpcRouter } from "../../src/host/channel/rpc.js";
import { startChannel, type RunningChannel } from "../../src/host/channel/server.js";
import type { ServerFrame } from "../../src/shared/protocol/rpc.js";
import type { SessionEvent } from "../../src/shared/session/events.js";
import { isTransientEvent } from "../../src/shared/session/events.js";


export interface ChannelFixture {
  readonly url: string;
  roundTrip(): Promise<{ result: ServerFrame; events: ServerFrame[] }>;
  attemptForeignOrigin(): Promise<"rejected" | "opened">;
  close(): Promise<void>;
}

const SAMPLE_EVENT: SessionEvent = {
  type: "user/message",
  seq: 1,
  at: "2026-01-01T00:00:00.000Z",
  text: "你好",
  attachments: [],
};

export async function makeChannel(): Promise<ChannelFixture> {
  const logger = silentLogger();
  const router = new RpcRouter(logger);
  router.register("system.info", () => ({
    home: "/tmp/home",
    platform: "win32" as const,
    dbPath: "/tmp/home/sessions",
  }));
  const hub = new SubscriptionHub(logger);
  const token = createToken();
  let running: RunningChannel;
  running = await startChannel({
    router,
    hub,
    token,
    rendererDir: null,
    logger,
    workspaceRoot: () => "",
  onSubscribe: async () => [SAMPLE_EVENT],
  });

  return {
    url: running.url,
    async roundTrip() {
      const origin = `http://${"127.0.0.1"}:${running.port}`;
      const ws = new WebSocket(`ws://127.0.0.1:${running.port}/ws?token=${token}`, {
        headers: { Origin: origin },
      });
      const received: ServerFrame[] = [];
      await new Promise<void>((done, reject) => {
        ws.on("open", () => done());
        ws.on("error", reject);
      });
      ws.on("message", (raw: unknown) => {
        received.push(JSON.parse(String(raw)) as ServerFrame);
      });
      ws.send(JSON.stringify({ kind: "subscribe", sessionId: "s1", sinceSeq: 0 }));
      ws.send(
        JSON.stringify({ kind: "rpc", rpcId: "rpc-1", method: "system.info", params: {} }),
      );
      const deadline = Date.now() + 3000;
      while (received.length < 2 && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 10));
      }
      ws.close();
      const result = received.find((frame) => frame.kind === "result");
      const events = received.filter((frame) => frame.kind === "events");
      if (result === undefined) throw new Error("没有收到 RPC 结果");
      return { result, events };
    },
    async attemptForeignOrigin() {
      const ws = new WebSocket(`ws://127.0.0.1:${running.port}/ws?token=${token}`, {
        headers: { Origin: "http://evil.example" },
      });
      return await new Promise<"rejected" | "opened">((resolve) => {
        ws.on("open", () => {
          ws.close();
          resolve("opened");
        });
        ws.on("error", () => resolve("rejected"));
        ws.on("unexpected-response", () => resolve("rejected"));
        setTimeout(() => resolve("rejected"), 1500);
      });
    },
    close: () => running.close(),
  };
}

export interface OverlapFixture {
  /** 订阅一次，收齐补发 + 缓冲推来的增量后返回所有 `events` 帧里的事件。 */
  collect(): Promise<SessionEvent[]>;
  close(): Promise<void>;
}

/**
 * 造"补发与缓冲重叠"的场景：
 *
 * 补发窗口里又写了一条 seq 3，它既被推进缓冲区、又出现在 `onSubscribe` 返回的
 * backlog 里——服务端必须只发一次。同批还带一条瞬态 `request/delta`（借 seq 3），
 * 它不在日志里，不能被 seq 过滤误杀。
 */
export async function makeBackfillOverlapChannel(): Promise<OverlapFixture> {
  const logger = silentLogger();
  const router = new RpcRouter(logger);
  const hub = new SubscriptionHub(logger);
  const token = createToken();
  const at = "2026-01-01T00:00:00.000Z";
  const sessionId = "overlap-1";

  const first: SessionEvent = { type: "user/message", seq: 1, at, text: "第一条", attachments: [] };
  const second: SessionEvent = { type: "user/message", seq: 2, at, text: "第二条", attachments: [] };
  const overlapping: SessionEvent = { type: "assistant/message", seq: 3, at, step: 0, text: "第三条" };
  const transient: SessionEvent = {
    type: "request/delta",
    seq: 3,
    at,
    step: 0,
    text: "第三",
  } as unknown as SessionEvent;

  const running = await startChannel({
    router,
    hub,
    token,
    rendererDir: null,
    logger,
    workspaceRoot: () => "",
  onSubscribe: async (id) => {
      // 补发窗口内到达的增量：先入缓冲，再"读日志"读到同一条，制造重叠。
      hub.publish(id, [transient, overlapping]);
      return [first, second, overlapping];
    },
  });

  return {
    async collect() {
      const origin = `http://127.0.0.1:${String(running.port)}`;
      const ws = new WebSocket(`ws://127.0.0.1:${String(running.port)}/ws?token=${token}`, {
        headers: { Origin: origin },
      });
      const events: SessionEvent[] = [];
      await new Promise<void>((done, reject) => {
        ws.on("open", () => done());
        ws.on("error", reject);
      });
      ws.on("message", (raw: unknown) => {
        const frame = JSON.parse(String(raw)) as ServerFrame;
        if (frame.kind === "events") events.push(...frame.events);
      });
      ws.send(JSON.stringify({ kind: "subscribe", sessionId, sinceSeq: 0 }));
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const persisted = events.filter((event) => !isTransientEvent(event.type));
        if (persisted.length >= 3 && events.length > persisted.length) break;
        await new Promise((done) => setTimeout(done, 10));
      }
      ws.close();
      return events;
    },
    close: () => running.close(),
  };
}
