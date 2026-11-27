/**
 * 首页输入框发消息：那时还没有会话。
 *
 * 曾经的行为是 `send()` 发现没有会话就直接 return —— 输入框被清空，消息却没发出去，
 * 界面上什么也不出现。现在应当先建会话、订阅它，再把这条消息发出去。
 */

import { describe, expect, it } from "vitest";
import { ClientStore, type ClientTransport } from "../../src/client/object/store.js";
import type { MethodName, MethodParams, MethodResult } from "../../src/shared/protocol/methods.js";

const SESSION = "44444444-4444-4444-8444-444444444444";

class RecordingTransport implements ClientTransport {
  currentStatus = "open" as const;
  subscribedSession: string | null = null;
  readonly calls: Array<{ method: MethodName; params: unknown }> = [];

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
    const results: Partial<Record<MethodName, unknown>> = {
      "workspace.list": { activeId: "ws1", items: [{ id: "ws1", path: "D:/w", name: "w", nativeSessions: {} }] },
      "session.create": { sessionId: SESSION },
      "message.send": { turnId: "turn-1" },
      "task.worktree.diff": {
        state: "conflict",
        branch: "supercoder/task/t_c1",
        files: ["src/a.ts"],
        stat: "src/a.ts | 2 +-",
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n+const token = '$& $$ $1';",
        message: "冲突：src/a.ts",
      },
    };
    const listy = method.endsWith(".list") || method === "agent.list";
    return Promise.resolve((results[method] ?? (listy ? [] : {})) as MethodResult<M>);
  }
}

describe("Main Page Message Sending", () => {
  it("creates session first when none exists without dropping message", async () => {
    const transport = new RecordingTransport();
    const store = new ClientStore({ transport, locale: "zh-CN" });
    await store.refreshAll();
    expect(store.snapshot().activeSessionId).toBeNull();

    await store.send("你好");

    const methods = transport.calls.map((call) => call.method);
    expect(methods.indexOf("session.create")).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf("message.send")).toBeGreaterThan(methods.indexOf("session.create"));
    expect(transport.calls.find((call) => call.method === "message.send")?.params).toMatchObject({ sessionId: SESSION, text: "你好" });
    expect(store.snapshot().activeSessionId).toBe(SESSION);
    expect(transport.subscribedSession).toBe(SESSION);
  });

  it("returns false and restores input when previous turn interruption is still in flight", async () => {
    const transport = new RecordingTransport();
    const store = new ClientStore({ transport, locale: "zh-CN", busyWaitMs: 50 });
    await store.refreshAll();
    await store.send("第一条");
    // 模拟宿主还在跑：界面处于 busy，且打断之后视图依旧是 running。
    (store as unknown as { patch: (p: unknown) => void }).patch({ busy: true });
    const before = transport.calls.length;

    expect(await store.send("第二条")).toBe(false);
    // 只发了中断，没有发出这条消息。
    const after = transport.calls.slice(before).map((call) => call.method);
    expect(after).toContain("turn.interrupt");
    expect(after).not.toContain("message.send");
  });

  it("dispatches 1-click AI conflict resolution with literal diff context", async () => {
    const transport = new RecordingTransport();
    const store = new ClientStore({ transport, locale: "zh-CN" });
    await store.refreshAll();
    await store.send("建立会话");
    // 模拟前一轮对话已结束、会话处于空闲状态
    (store as unknown as { patch: (p: unknown) => void }).patch({ busy: false });
    const sent = await store.resolveWorktreeConflict({
      taskId: "t_c1",
      childId: "t_c1",
      providerId: "codex-acp",
      agentId: "codex",
      goal: "修改 src/a.ts",
      instruction: "修改 src/a.ts",
      mode: "write",
      state: "returned",
      receipt: null,
      result: null,
      retryCount: 0,
      createdAt: "2026-11-27T00:00:00.000Z",
      updatedAt: "2026-11-27T00:00:00.000Z",
      worktree: {
        state: "conflict",
        branch: "supercoder/task/t_c1",
        files: ["src/a.ts"],
        message: "冲突：src/a.ts",
      },
    });
    expect(sent).toBe(true);
    const diffCall = transport.calls.find((call) => call.method === "task.worktree.diff");
    expect(diffCall?.params).toEqual({ sessionId: SESSION, taskId: "t_c1" });
    const sendCalls = transport.calls.filter((call) => call.method === "message.send");
    const lastSend = sendCalls[sendCalls.length - 1]?.params as { text: string } | undefined;
    expect(lastSend?.text).toContain("t_c1");
    expect(lastSend?.text).toContain("supercoder/task/t_c1");
    expect(lastSend?.text).toContain("src/a.ts");
    expect(lastSend?.text).toContain("$& $$ $1");
  });
});
