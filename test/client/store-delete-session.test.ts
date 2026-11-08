/**
 * 会话删除功能验证。
 *
 * 删除当前会话时要一并清掉订阅、派生器与视图，再重新加载列表回到剩下的第一条；
 * 否则会留下指向已删日志的视图，后续发送会撞 not_found。
 */

import { describe, expect, it } from "vitest";
import { ClientStore, type ClientTransport } from "../../src/client/object/store.js";
import type { MethodName, MethodParams, MethodResult } from "../../src/shared/protocol/methods.js";

const SESSION_A = "66666666-6666-4666-8666-666666666666";
const SESSION_B = "77777777-7777-4777-8777-777777777777";

class DeletingTransport implements ClientTransport {
  currentStatus = "open" as const;
  subscribedSession: string | null = null;
  readonly calls: Array<{ method: MethodName; params: unknown }> = [];
  /** 删掉之后 session.list 就只剩这一条。 */
  sessions = [SESSION_A, SESSION_B];

  connect(): void {}
  close(): void {}
  subscribe(sessionId: string): void {
    this.subscribedSession = sessionId;
  }
  unsubscribe(): void {
    this.subscribedSession = null;
  }

  rpc<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    this.calls.push({ method, params });
    if (method === "workspace.list") {
      return Promise.resolve({
        activeId: "ws1",
        items: [{ id: "ws1", path: "D:/w", name: "w", nativeSessions: {} }],
      } as unknown as MethodResult<M>);
    }
    if (method === "session.list") {
      return Promise.resolve(
        this.sessions.map((sessionId) => ({
          sessionId,
          title: sessionId === SESSION_A ? "A" : "B",
          workspaceId: "ws1",
          lastSeq: 0,
          status: "idle",
          counts: { user: 0, assistant: 0, tool: 0 },
          updatedAt: new Date(0).toISOString(),
        })) as unknown as MethodResult<M>,
      );
    }
    if (method === "session.delete") {
      const target = (params as unknown as { sessionId: string }).sessionId;
      this.sessions = this.sessions.filter((sessionId) => sessionId !== target);
      return Promise.resolve({} as MethodResult<M>);
    }
    const listy = method.endsWith(".list") || method === "agent.list";
    return Promise.resolve((listy ? [] : {}) as MethodResult<M>);
  }
}

describe("Delete Session", () => {
  it("unsubscribes, clears view, and opens first remaining session upon deleting active session", async () => {
    const transport = new DeletingTransport();
    const store = new ClientStore({ transport, locale: "zh-CN" });
    await store.refreshAll();
    await store.selectSession(SESSION_A);
    expect(transport.subscribedSession).toBe(SESSION_A);

    expect(await store.deleteSession(SESSION_A)).toBe(true);

    const state = store.snapshot();
    expect(state.sessions.map((session) => session.sessionId)).toEqual([SESSION_B]);
    expect(state.activeSessionId).toBe(SESSION_B);
    expect(state.view).toBeNull();
    expect(transport.subscribedSession).toBe(SESSION_B);
    expect(transport.calls.map((call) => call.method)).toContain("session.delete");
  });

  it("deleting another session does not alter current active view", async () => {
    const transport = new DeletingTransport();
    const store = new ClientStore({ transport, locale: "zh-CN" });
    await store.refreshAll();
    await store.selectSession(SESSION_A);

    expect(await store.deleteSession(SESSION_B)).toBe(true);

    expect(store.snapshot().activeSessionId).toBe(SESSION_A);
    expect(transport.subscribedSession).toBe(SESSION_A);
  });

  it("returns false and leaves state intact when host denies deletion", async () => {
    const transport = new DeletingTransport();
    transport.rpc = ((method: MethodName) => {
      if (method === "session.delete") return Promise.reject(new Error("会话正在执行回合"));
      return Promise.resolve((method.endsWith(".list") || method === "agent.list" ? [] : {}) as never);
    }) as DeletingTransport["rpc"];
    const store = new ClientStore({ transport, locale: "zh-CN" });
    await store.refreshAll();
    await store.selectSession(SESSION_A);

    expect(await store.deleteSession(SESSION_A)).toBe(false);
    expect(store.snapshot().activeSessionId).toBe(SESSION_A);
    expect(store.snapshot().error).toContain("正在执行回合");
  });
});
