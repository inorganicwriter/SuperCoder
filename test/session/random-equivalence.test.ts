/**
 * 随机序列等价性：写入时的内存投影 === 重启后从日志重算的投影。
 * 遵循架构设计规范。
 *
 * 固定种子：失败可复现。三种子各自 500 条事件，类型、文本、工具结果、任务分派结果混排，
 * 中间夹 rewind —— 这是唯一一处"历史会被裁掉"的地方，最容易被漏掉。
 */

import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/host/boot/logger.js";
import { SessionStore } from "../../src/host/session/store.js";
import type { DerivedView } from "../../src/shared/session/derive.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();
const EVENT_COUNT = 500;

/** 线性同余：够确定的伪随机，种子写死就能复现。 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

type Append = (next: () => number) => void;

function buildWriter(store: SessionStore, sessionId: string): { append: Append; done: () => DerivedView } {
  const handle = store.get(sessionId);
  return {
    append(next) {
      const dice = next();
      const seq = (): number => handle.lastSeq;
      if (dice < 0.3) {
        handle.append("user/message", { text: `问题 ${String(seq() + 1)}`, attachments: [] });
      } else if (dice < 0.55) {
        handle.append("assistant/message", { step: seq() + 1, text: `回答 ${String(seq() + 1)}` });
      } else if (dice < 0.67) {
        handle.append("tool/call", {
          callId: `call-${String(seq() + 1)}`,
          name: "query_task_status",
          args: { task_id: `t-${String(seq() + 1)}` },
        });
      } else if (dice < 0.79) {
        handle.append("tool/result", {
          callId: `call-${String(seq() + 1)}`,
          outcome:
            dice < 0.72
              ? { status: "ok", value: { n: seq() } }
              : dice < 0.76
                ? { status: "error", code: "failed", message: "工具失败", retryable: true }
                : { status: "uncertain", code: "execution_state_unknown", detail: "没等到回执" },
        });
      } else if (dice < 0.85) {
        handle.append("delegation/spawn", {
          childId: `task-${String(seq() + 1)}`,
          provider: "codex",
          agentId: "codex",
          instruction: "补一句",
          goal: "用户原话",
          mode: "read-only",
        });
      } else if (dice < 0.9) {
        handle.append("delegation/delivery", { childId: `task-${String(seq())}`, state: "queued" });
      } else if (dice < 0.94) {
        handle.append("delegation/result", {
          childId: `task-${String(seq())}`,
          result: { status: "unknown", observed: "进程已退出", since: "2026-01-01T00:00:00.000Z" },
        });
      } else if (dice < 0.97) {
        handle.append("capsule/saved", {
          capsuleId: `cap-${String(seq() + 1)}`,
          action: "create",
          title: "交接",
          humanSummary: "摘要",
          technicalHandoff: "细节",
          touchedFiles: ["src/a.ts"],
          scope: "chat",
        });
      } else if (seq() > 6) {
        // rewind：把后面 1~5 条消息裁掉。
        const back = 1 + Math.floor(next() * 5);
        handle.append("user/rewind", { toSeq: Math.max(1, seq() - back) });
      } else {
        handle.append("turn/start", { chatId: sessionId });
      }
      if (seq() % 17 === 0) handle.append("turn/start", { chatId: sessionId });
      if (seq() % 23 === 0) handle.append("turn/end", { status: "completed" });
    },
    done: () => handle.view(),
  };
}

function runSeed(seed: number): void {
  const home = makeTempHome();
  try {
    const store = new SessionStore({ paths: home.paths, logger });
    const { sessionId } = store.create("ws-1", `随机序列 ${String(seed)}`);
    const writer = buildWriter(store, sessionId);
    const next = rng(seed);
    for (let index = 0; index < EVENT_COUNT; index += 1) writer.append(next);
    const before = writer.done();
    const handle = store.get(sessionId);
    const lastSeq = handle.lastSeq;
    const events = handle.allEvents();
    const rewinds = events.filter((event) => event.type === "user/rewind").length;
    const messages = events.filter(
      (event) => event.type === "user/message" || event.type === "assistant/message",
    ).length;
    // 断言生成的测试序列包含回撤事件，确保具备充分的测试覆盖率。
    expect(rewinds).toBeGreaterThanOrEqual(5);
    expect(before.messages.length).toBeLessThan(messages);
    expect(new Set(events.map((e) => e.type)).size).toBeGreaterThanOrEqual(8);
    store.closeAll();

    const reopened = new SessionStore({ paths: home.paths, logger });
    const after = reopened.get(sessionId).view();
    expect(after).toEqual(before);
    expect(after.lastSeq).toBe(lastSeq);
    expect(after.lastSeq).toBeGreaterThan(0);
    reopened.closeAll();
  } finally {
    home.cleanup();
  }
}

describe("Random Sequence Equivalence (Fixed Seed)", () => {
  it("seed 1: produces identical field-by-field projection after 500 mixed events", () => {
    runSeed(1);
  });

  it("seed 20260101: produces identical field-by-field projection after 500 mixed events", () => {
    runSeed(20_260_101);
  });

  it("seed 424242: produces identical field-by-field projection after 500 mixed events", () => {
    runSeed(424_242);
  });
});
