/**
 * 流式增量（`request/delta`）的消费端。遵循架构设计规范。
 *
 * 这条通道是瞬态的：不落盘、不占 seq（借下一次写入的序号），所以它既不能进
 * `appliedEvents` 镜像，也不能被按 seq 去重——否则同 seq 的正式消息会被当成重复丢掉。
 */

import { describe, expect, it } from "vitest";
import { ClientStore, type ClientTransport } from "../../src/client/object/store.js";
import type { SessionEvent } from "../../src/shared/session/events.js";
import type { MethodName, MethodParams, MethodResult } from "../../src/shared/protocol/methods.js";

const SESSION = "33333333-3333-4333-8333-333333333333";

class FakeTransport implements ClientTransport {
  currentStatus = "open" as const;
  subscribedSession: string | null = null;

  connect(): void {}
  close(): void {}

  subscribe(sessionId: string): void {
    this.subscribedSession = sessionId;
  }

  unsubscribe(): void {
    this.subscribedSession = null;
  }

  rpc<M extends MethodName>(method: M, _params: MethodParams<M>): Promise<MethodResult<M>> {
    const empty = (method === "task.list" || method === "capsule.list" ? [] : {}) as MethodResult<M>;
    return Promise.resolve(empty);
  }
}

function at(seq: number): string {
  return new Date(1_700_000_000_000 + seq).toISOString();
}

function user(seq: number, text: string): SessionEvent {
  return { seq, at: at(seq), sessionId: SESSION, type: "user/message", text, attachments: [] } as unknown as SessionEvent;
}

function turnStart(seq: number): SessionEvent {
  return { seq, at: at(seq), sessionId: SESSION, type: "turn/start", chatId: SESSION } as unknown as SessionEvent;
}

function turnEnd(seq: number, status: "completed" | "interrupted"): SessionEvent {
  return { seq, at: at(seq), sessionId: SESSION, type: "turn/end", status } as unknown as SessionEvent;
}

function assistant(seq: number, step: number, text: string): SessionEvent {
  return { seq, at: at(seq), sessionId: SESSION, type: "assistant/message", step, text } as unknown as SessionEvent;
}

/** 瞬态增量：seq 借"下一次写入"的那个号。 */
function delta(seq: number, step: number, text: string): SessionEvent {
  return { seq, at: at(seq), sessionId: SESSION, type: "request/delta", step, text } as unknown as SessionEvent;
}

async function makeStore(): Promise<ClientStore> {
  const store = new ClientStore({ transport: new FakeTransport(), locale: "zh-CN" });
  await store.selectSession(SESSION);
  return store;
}

describe("Streaming Delta Processing", () => {
  it("concatenates three deltas into streaming text and clears when formal message arrives", async () => {
    const store = await makeStore();
    store.applyEvents(SESSION, [user(1, "问一句"), turnStart(2)]);
    const before = store.appliedEvents.map((event) => event.seq);
    expect(before).toEqual([1, 2]);

    // seq 3 是"下一次写入"的号，三条增量都借它。
    store.applyEvents(SESSION, [delta(3, 1, "你"), delta(3, 1, "好"), delta(3, 1, "呀")]);
    expect(store.snapshot().view?.streaming).toEqual({ step: 1, text: "你好呀" });
    // 瞬态不推进游标、不进镜像。
    expect(store.appliedEvents.map((event) => event.seq)).toEqual(before);
    expect(store.appliedEvents.some((event) => event.type === "request/delta")).toBe(false);

    store.applyEvents(SESSION, [assistant(3, 1, "你好呀")]);
    const view = store.snapshot().view;
    expect(view?.streaming).toBeNull();
    // 正式消息只出现一次（同 seq 的增量没有把它顶掉）。
    expect(view?.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(view?.messages.map((message) => message.seq)).toEqual([1, 3]);
    expect(store.appliedEvents.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("view lastSeq counts only persisted events and ignores borrowed transient sequence", async () => {
    const store = await makeStore();
    store.applyEvents(SESSION, [user(1, "问"), turnStart(2)]);
    // 三条增量都借 seq 3，视图的 lastSeq 必须停在 2。
    store.applyEvents(SESSION, [delta(3, 1, "你"), delta(3, 1, "好"), delta(3, 1, "呀")]);
    expect(store.snapshot().view?.streaming?.text).toBe("你好呀");
    expect(store.snapshot().view?.lastSeq).toBe(2);

    // 正式消息落盘之后才推进到 3。
    store.applyEvents(SESSION, [assistant(3, 1, "你好呀")]);
    expect(store.snapshot().view?.lastSeq).toBe(3);
  });

  it("clears pending streaming buffer on turn completion", async () => {
    const store = await makeStore();
    store.applyEvents(SESSION, [user(1, "问"), turnStart(2), delta(3, 1, "半句")]);
    expect(store.snapshot().view?.streaming?.text).toBe("半句");

    store.applyEvents(SESSION, [turnEnd(3, "interrupted")]);
    expect(store.snapshot().view?.streaming).toBeNull();
    expect(store.snapshot().view?.messages).toHaveLength(1);
  });

  it("starts fresh delta accumulator when step changes", async () => {
    const store = await makeStore();
    store.applyEvents(SESSION, [user(1, "问"), turnStart(2), delta(3, 1, "第一段")]);
    store.applyEvents(SESSION, [delta(4, 2, "第二段")]);
    expect(store.snapshot().view?.streaming).toEqual({ step: 2, text: "第二段" });

    // 同 step 的正式消息收尾；另一个 step 的正式消息不该清掉当前这段。
    store.applyEvents(SESSION, [assistant(4, 2, "第二段")]);
    expect(store.snapshot().view?.streaming).toBeNull();
  });

  it("clears leftover streaming text when a new turn begins", async () => {
    const store = await makeStore();
    store.applyEvents(SESSION, [user(1, "第一问"), turnStart(2), delta(3, 1, "没结尾")]);
    store.applyEvents(SESSION, [user(4, "第二问"), turnStart(5)]);
    expect(store.snapshot().view?.streaming).toBeNull();
    expect(store.snapshot().view?.messages).toHaveLength(2);
  });
});
