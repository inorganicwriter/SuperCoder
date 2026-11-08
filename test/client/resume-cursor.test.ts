/**
 * 重连光标的确定性验证。遵循架构设计规范。
 *
 * 光标（`resumeFrom`）的语义是"最后一条**已落盘**事件的序号"。流式增量
 * `request/delta` 借的是"下一条落盘事件的序号"，把它算进光标就会让重连从 N+1
 * 续订，而 N+1 那条正式消息恰好被跳过——界面不报错，只是永远少一条。
 *
 * 这里用假 socket 直接驱动 `Connection`，不依赖真实网络与计时。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Connection } from "../../src/client/object/connection.js";
import type { ClientFrame, ServerFrame } from "../../src/shared/protocol/rpc.js";

type Listener = (event: { data?: unknown }) => void;

/** 够 `Connection` 用的假 WebSocket：只实现它调用的那几个成员。 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emitClose();
  }

  frames(): ClientFrame[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientFrame);
  }

  /** 服务端视角：连接建立。 */
  emitOpen(): void {
    this.readyState = FakeSocket.OPEN;
    this.dispatch("open", {});
  }

  /** 服务端视角：推一帧。 */
  emitMessage(frame: ServerFrame): void {
    this.dispatch("message", { data: JSON.stringify(frame) });
  }

  /** 服务端视角：连接断开。 */
  emitClose(): void {
    this.readyState = FakeSocket.CLOSED;
    this.dispatch("close", {});
  }

  private dispatch(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;

beforeEach(() => {
  FakeSocket.instances.length = 0;
});

function eventsFrame(events: readonly unknown[]): ServerFrame {
  return { kind: "events", sessionId: "s", events } as unknown as ServerFrame;
}

const AT = "2026-01-01T00:00:00.000Z";

/** 瞬态增量：seq 是"下一条落盘事件的序号"（借号，不落盘）。 */
function delta(seq: number, text: string): unknown {
  return { type: "request/delta", seq, at: AT, step: 0, text };
}

function assistant(seq: number, text: string): unknown {
  return { type: "assistant/message", seq, at: AT, step: 0, text };
}

interface Harness {
  readonly connection: Connection;
  readonly statuses: string[];
  readonly received: number[];
}

function makeConnection(retryBaseMs = 10): Harness {
  const statuses: string[] = [];
  const received: number[] = [];
  const connection = new Connection({
    port: 1,
    token: "t",
    retryBaseMs,
    onStatus: (status) => statuses.push(status),
    onEvents: (sessionId, events) => {
      expect(sessionId).toBe("s");
      for (const event of events) received.push(event.seq);
    },
  });
  connection.connect();
  return { connection, statuses, received };
}

function first(): FakeSocket {
  const socket = FakeSocket.instances[0];
  if (socket === undefined) throw new Error("没有建立连接");
  return socket;
}

async function waitForSocket(index: number): Promise<FakeSocket> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const socket = FakeSocket.instances[index];
    if (socket !== undefined) return socket;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待第 ${String(index + 1)} 个 socket 超时`);
}

describe("Reconnect Cursor Progression", () => {
  it("does not advance cursor when receiving only transient deltas", () => {
    const { connection } = makeConnection();
    first().emitOpen();
    connection.subscribe("s", 0);

    first().emitMessage(eventsFrame([delta(11, "半句")]));
    expect(connection.resumeFrom).toBe(0);
  });

  it("advances cursor to event seq once persisted event arrives", () => {
    const { connection } = makeConnection();
    first().emitOpen();
    connection.subscribe("s", 0);

    first().emitMessage(eventsFrame([delta(11, "半句")]));
    first().emitMessage(eventsFrame([assistant(11, "半句")]));
    expect(connection.resumeFrom).toBe(11);
  });

  it("resumes subscription from last persisted seq when disconnected during streaming", async () => {
    const { connection } = makeConnection(10);
    first().emitOpen();
    connection.subscribe("s", 0);
    expect(first().frames()).toEqual([{ kind: "subscribe", sessionId: "s", sinceSeq: 0 }]);

    first().emitMessage(eventsFrame([delta(11, "半句")]));
    first().emitClose();

    const second = await waitForSocket(1);
    second.emitOpen();

    // 关键断言：sinceSeq 是 0，不是 11——11 那条正式消息还没到过。
    expect(second.frames()).toEqual([{ kind: "subscribe", sessionId: "s", sinceSeq: 0 }]);
    connection.close();
  });

  it("resumes from advanced cursor position on subsequent disconnect", async () => {
    const { connection } = makeConnection(10);
    first().emitOpen();
    connection.subscribe("s", 0);

    first().emitMessage(eventsFrame([delta(12, "接着")]));
    first().emitMessage(eventsFrame([assistant(12, "接着")]));
    expect(connection.resumeFrom).toBe(12);

    first().emitClose();
    const second = await waitForSocket(1);
    second.emitOpen();

    expect(second.frames()).toEqual([{ kind: "subscribe", sessionId: "s", sinceSeq: 12 }]);
    connection.close();
  });

  it("maintains correct cursor progression when transient events are mixed in batch", () => {
    const { connection, received } = makeConnection();
    first().emitOpen();
    connection.subscribe("s", 0);

    first().emitMessage(eventsFrame([assistant(13, "答案"), delta(14, "下一段"), delta(14, "再来")]));
    expect(connection.resumeFrom).toBe(13);
    // 瞬态照样交给上层（流式渲染要用），只是不推进光标。
    expect(received).toEqual([13, 14, 14]);
  });
});
