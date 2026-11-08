/**
 * 界面状态增量派生性能验证。
 *
 * store 之前每收到一批事件就从头发一次 `deriveView()`，1 万条会话每批要重算 1 万条。
 * 验证增量事件派生的时间预算及状态正确性。
 */

import { describe, expect, it } from "vitest";
import { ClientStore, type ClientTransport } from "../../src/client/object/store.js";
import type { ClientState } from "../../src/client/object/store.js";
import { deriveView } from "../../src/shared/session/derive.js";
import type { SessionEvent } from "../../src/shared/session/events.js";
import type { MethodName, MethodParams, MethodResult } from "../../src/shared/protocol/methods.js";
import { UI_DERIVATION_MS } from "../../bench/budgets.js";

const SESSION = "11111111-1111-4111-8111-111111111111";

/** 不发网络：`selectSession` 会问两个列表，其余方法都当成功空回包。 */
class FakeTransport implements ClientTransport {
  currentStatus = "open" as const;
  subscribedSession: string | null = null;
  calls: string[] = [];

  connect(): void {}
  close(): void {}
  subscribe(sessionId: string): void {
    this.subscribedSession = sessionId;
  }
  unsubscribe(): void {
    this.subscribedSession = null;
  }

  rpc<M extends MethodName>(method: M, _params: MethodParams<M>): Promise<MethodResult<M>> {
    this.calls.push(method);
    const empty = (method === "task.list" || method === "capsule.list" ? [] : {}) as MethodResult<M>;
    return Promise.resolve(empty);
  }
}

function message(seq: number, index: number): SessionEvent {
  const at = new Date(1_700_000_000_000 + seq).toISOString();
  if (index % 2 === 0) {
    return {
      seq,
      at,
      sessionId: SESSION,
      type: "user/message",
      text: `问题 ${String(index)}`,
      attachments: [],
    } as unknown as SessionEvent;
  }
  return {
    seq,
    at,
    sessionId: SESSION,
    type: "assistant/message",
    step: 0,
    text: `回答 ${String(index)}`,
    usage: null,
  } as unknown as SessionEvent;
}

async function makeStore(): Promise<{ store: ClientStore; transport: FakeTransport }> {
  const transport = new FakeTransport();
  const store = new ClientStore({ transport, locale: "zh-CN" });
  await store.selectSession(SESSION);
  return { store, transport };
}

describe("Incremental Derivation Benchmark", () => {
  it(`200 batches after 10k events: per-batch duration < ${String(UI_DERIVATION_MS)}ms`, async () => {
    const { store } = await makeStore();
    const initial: SessionEvent[] = [];
    for (let index = 0; index < 10_000; index += 1) initial.push(message(index + 1, index));
    store.applyEvents(SESSION, initial);
    expect(store.snapshot().view?.messages).toHaveLength(10_000);

    const durations: number[] = [];
    let seq = 10_001;
    for (let batch = 0; batch < 200; batch += 1) {
      const events: SessionEvent[] = [];
      for (let offset = 0; offset < 10; offset += 1) {
        events.push(message(seq, seq));
        seq += 1;
      }
      const started = performance.now();
      store.applyEvents(SESSION, events);
      durations.push(performance.now() - started);
    }

    const slowest = Math.max(...durations);
    const view = store.snapshot().view;
    expect(view?.messages).toHaveLength(12_000);
    expect(view?.lastSeq).toBe(seq - 1);
    // 单批含 apply + view()（含 1.2 万条消息数组的浅拷贝）。
    // 预算来自 bench/budgets.ts 的同一个常量，不在这里另抄一份数字。
    expect(slowest).toBeLessThan(UI_DERIVATION_MS);
  }, 60_000);

  it("incremental projection matches full recomputation field by field", async () => {
    const { store } = await makeStore();
    const events: SessionEvent[] = [];
    for (let index = 0; index < 50; index += 1) events.push(message(index + 1, index));
    // 分 5 批投喂，模拟真实推送。
    for (let offset = 0; offset < events.length; offset += 10) {
      store.applyEvents(SESSION, events.slice(offset, offset + 10));
    }

    const state: ClientState = store.snapshot();
    const expected = deriveView(events, { sessionId: SESSION, workspaceId: "" });
    expect(state.view).toEqual(expected);
    expect(store.appliedEvents.map((event) => event.seq)).toEqual(
      events.map((event) => event.seq),
    );
  });

  it("switching session resets projection so old events never leak into new session", async () => {
    const { store } = await makeStore();
    store.applyEvents(SESSION, [message(1, 0), message(2, 1)]);
    expect(store.snapshot().view?.messages).toHaveLength(2);

    const other = "22222222-2222-4222-8222-222222222222";
    await store.selectSession(other);
    expect(store.snapshot().view).toBeNull();
    expect(store.appliedEvents).toHaveLength(0);

    store.applyEvents(other, [message(1, 0)]);
    expect(store.snapshot().view?.messages).toHaveLength(1);
    // 旧会话的事件仍会被忽略（不是当前会话）。
    store.applyEvents(SESSION, [message(3, 2)]);
    expect(store.snapshot().view?.messages).toHaveLength(1);
  });
});
