/**
 * 回合结束后还挂着的审批与提问。
 *
 * 提问时用户直接在输入框发消息，会先中断当前回合；中断路径不写 question/answered，
 * 那条提问曾经永远钉在对话末尾、留在通知里，会话状态也一直是"等待中"。
 * 进程在等审批时退出也是同样的效果。
 */

import { describe, expect, it } from "vitest";
import { SessionDerivation } from "../../src/shared/session/derive.js";
import type { SessionEvent } from "../../src/shared/session/events.js";

const at = (seq: number): string => new Date(1_700_000_000_000 + seq * 1000).toISOString();
const ev = (seq: number, type: string, payload: Record<string, unknown> = {}): SessionEvent =>
  ({ seq, at: at(seq), type, ...payload }) as SessionEvent;

function derive(events: readonly SessionEvent[]): ReturnType<SessionDerivation["view"]> {
  const derivation = new SessionDerivation({ sessionId: "s", workspaceId: "ws" });
  for (const event of events) derivation.apply(event);
  return derivation.view();
}

describe("Turn Boundary Finalization", () => {
  it("marks unanswered questions expired and returns session to idle when interrupted", () => {
    const view = derive([
      ev(1, "turn/start", { chatId: "s" }),
      ev(2, "user/message", { text: "改一下", attachments: [] }),
      ev(3, "question/asked", { questionId: "q1", question: "用哪种方案？", options: ["甲", "乙"] }),
      ev(4, "turn/end", { status: "interrupted" }),
    ]);
    expect(view.questions[0]).toMatchObject({ answer: null, expired: true });
    expect(view.pending).toEqual([]);
    expect(view.status).toBe("idle");
  });

  it("marks pending approvals failed and running approvals unknown when process exits", () => {
    const view = derive([
      ev(1, "turn/start", { chatId: "s" }),
      ev(2, "tool/call", { callId: "a", name: "run_workspace_verification", args: {} }),
      ev(3, "tool/approval-requested", { callId: "a" }),
      ev(4, "tool/call", { callId: "b", name: "dispatch_task", args: {} }),
      // 没有 turn/end：进程在这里退出。
      ev(5, "turn/start", { chatId: "s" }),
    ]);
    const states = Object.fromEntries(view.tools.map((tool) => [tool.callId, tool.state]));
    expect(states).toEqual({ a: "error", b: "uncertain" });
    expect(view.pending.filter((item) => item.kind === "approval")).toEqual([]);
  });

  it("leaves answered questions intact", () => {
    const view = derive([
      ev(1, "turn/start", { chatId: "s" }),
      ev(2, "question/asked", { questionId: "q1", question: "继续吗？", options: [] }),
      ev(3, "question/answered", { questionId: "q1", answer: "继续" }),
      ev(4, "turn/end", { status: "completed" }),
    ]);
    expect(view.questions[0]).toMatchObject({ answer: "继续", expired: false });
  });
});
