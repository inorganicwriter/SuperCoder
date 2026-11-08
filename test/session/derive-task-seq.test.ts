/**
 * 任务卡片在对话历史中的渲染时序验证。
 *
 * 卡片按 spawn 事件的 seq 插入。`delegation/result` 重建任务视图时必须带上这个 seq；
 * 缺了它，结算后的卡片会按 Number.MAX_SAFE_INTEGER 排序，落到对话末尾。
 */

import { describe, expect, it } from "vitest";
import { deriveView } from "../../src/shared/session/derive.js";
import type { SessionEvent } from "../../src/shared/session/events.js";

const CTX = { sessionId: "11111111-1111-4111-8111-111111111111", workspaceId: "w1" };
const AT = new Date(1_700_000_000_000).toISOString();

function event(seq: number, type: string, rest: Record<string, unknown>): SessionEvent {
  return { seq, at: AT, type, ...rest } as unknown as SessionEvent;
}

describe("Task Card Timeline Positioning", () => {
  it("anchors task card to original spawn sequence position even after failure", () => {
    const events = [
      event(1, "turn/start", { chatId: CTX.sessionId }),
      event(2, "user/message", { text: "跑一下测试", attachments: [] }),
      event(3, "tool/call", { callId: "c1", name: "dispatch_task", args: {} }),
      event(4, "delegation/spawn", {
        childId: "t1",
        provider: "codex",
        agentId: "codex",
        instruction: "跑测试",
        goal: "跑一下测试",
        mode: "write",
      }),
      event(5, "delegation/result", {
        childId: "t1",
        result: { status: "failed", diagnostic: { stage: "turn", category: "process" }, durationMs: 12 },
      }),
      event(6, "assistant/message", { step: 0, text: "任务分派失败了", usage: null }),
      event(7, "turn/end", { status: "completed" }),
      event(8, "turn/start", { chatId: CTX.sessionId }),
      event(9, "user/message", { text: "再试一次", attachments: [] }),
      event(10, "assistant/message", { step: 0, text: "好", usage: null }),
      event(11, "turn/end", { status: "completed" }),
    ];
    const view = deriveView(events, CTX);
    const task = view.tasks.find((item) => item.taskId === "t1");
    expect(task?.state).toBe("failed");
    expect(task?.seq).toBe(4);
  });

  it("retains spawn sequence number for successful task completion", () => {
    const events = [
      event(1, "delegation/spawn", {
        childId: "t2",
        provider: "codex",
        agentId: "codex",
        instruction: "",
        goal: "看看结构",
        mode: "read-only",
      }),
      event(2, "delegation/result", { childId: "t2", result: { status: "ok", answer: "结构如下", durationMs: 3 } }),
    ];
    expect(deriveView(events, CTX).tasks[0]?.seq).toBe(1);
  });
});
