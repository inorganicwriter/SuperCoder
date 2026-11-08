/**
 * 答案选择的分级。遵循架构设计规范。
 *
 * | 观察到的 phase   | 处理                                  |
 * |------------------|---------------------------------------|
 * | final_answer     | 采纳并立即结束                        |
 * | partial_answer   | 记为候选；之后若还有工具调用则作废    |
 * | null             | 兼容候选（旧版本没有 phase 字段）     |
 * | commentary       | 跳过：那是过程话，不是结果            |
 * | 其它             | invalid-result：整轮判失败            |
 *
 * 优先级 final_answer > partial_answer > null：早期实现是"后写覆盖先写"，
 * 于是 [{partial}, {null}] 会返回 null 那条（把兼容候选当成了更好的答案）。
 */

import { describe, expect, it } from "vitest";
import { selectAnswer } from "../../src/host/delegation/answer.js";

describe("Answer Selection Hierarchy", () => {
  it("accepts final_answer and completes immediately", () => {
    expect(
      selectAnswer([
        { phase: "partial_answer", text: "候选" },
        { phase: "final_answer", text: "结论" },
        { phase: "final_answer", text: "后来的结论" },
      ]),
    ).toEqual({ ok: true, answer: "结论" });
  });

  it("skips commentary without treating it as result", () => {
    expect(
      selectAnswer([
        { phase: "commentary", text: "我先看看" },
        { phase: "partial_answer", text: "候选" },
      ]),
    ).toEqual({ ok: true, answer: "候选" });
    expect(selectAnswer([{ phase: "commentary", text: "只有过程话" }]).ok).toBe(false);
  });

  it("records partial_answer as candidate and voids it if tool call follows", () => {
    expect(selectAnswer([{ phase: "partial_answer", text: "候选" }])).toEqual({
      ok: true,
      answer: "候选",
    });
    const voided = selectAnswer([
      { phase: "partial_answer", text: "候选", toolCallAfter: true },
    ]);
    expect(voided.ok).toBe(false);
    if (!voided.ok) expect(voided.detail).toContain("工具调用");
  });

  it("treats null as compatible fallback candidate only when no better answer exists", () => {
    expect(selectAnswer([{ phase: null, text: "旧格式" }])).toEqual({
      ok: true,
      answer: "旧格式",
    });
    // 正式答案优先。
    expect(
      selectAnswer([
        { phase: null, text: "旧格式" },
        { phase: "final_answer", text: "新答案" },
      ]),
    ).toEqual({ ok: true, answer: "新答案" });
  });

  it("preserves partial candidate when null appears afterwards", () => {
    expect(
      selectAnswer([
        { phase: "partial_answer", text: "候选" },
        { phase: null, text: "旧格式" },
      ]),
    ).toEqual({ ok: true, answer: "候选" });
    // 反过来也一样：null 先出现，partial 后来更好。
    expect(
      selectAnswer([
        { phase: null, text: "旧格式" },
        { phase: "partial_answer", text: "候选" },
      ]),
    ).toEqual({ ok: true, answer: "候选" });
  });

  it("aggregates stateless responses keeping latest complete record", () => {
    expect(
      selectAnswer([
        { phase: null, text: "旧格式一" },
        { phase: null, text: "旧格式二" },
      ]),
    ).toEqual({ ok: true, answer: "旧格式二" });
  });

  it("toolCallAfter only applies to partial_answer while compatible candidate is exempt", () => {
    expect(selectAnswer([{ phase: null, text: "旧格式", toolCallAfter: true }])).toEqual({
      ok: true,
      answer: "旧格式",
    });
  });

  it("treats unknown phase as invalid-result for the turn", () => {
    const result = selectAnswer([{ phase: "thinking", text: "?" }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.category).toBe("invalid-result");
      expect(result.detail).toContain("thinking");
      expect(result.detail).toContain("未识别");
    }
  });

  it("treats empty candidate set as invalid-result without returning blank answer", () => {
    expect(selectAnswer([]).ok).toBe(false);
    expect(selectAnswer([{ phase: "partial_answer", text: "   " }]).ok).toBe(false);
  });
});
