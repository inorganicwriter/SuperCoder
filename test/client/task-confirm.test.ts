/**
 * 已确认副作用按任务维度隔离校验。
 *
 * 状态曾经是组件级的一个布尔，绑在每个 unknown 任务上：勾选任务 A 会让 B、C 的重试按钮
 * 同时可用，并一起传 confirmSideEffects: true —— 一次勾选授权重试所有未知态任务。
 * 这里只放纯函数，组件负责调用；仓库没有 jsdom，判断逻辑必须能脱离 React 单测。
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_CONFIRMED,
  isConfirmed,
  toggleConfirmed,
  type ConfirmedTasks,
} from "../../src/client/features/tasks/confirm.js";

describe("Side Effect Confirmation Logic", () => {
  it("defaults all task confirmations to false", () => {
    expect(isConfirmed(EMPTY_CONFIRMED, "task_a")).toBe(false);
    expect(EMPTY_CONFIRMED.size).toBe(0);
  });

  it("confirming one task does not confirm another task", () => {
    const next = toggleConfirmed(EMPTY_CONFIRMED, "task_a", true);
    expect(isConfirmed(next, "task_a")).toBe(true);
    expect(isConfirmed(next, "task_b")).toBe(false);
    expect([...next]).toEqual(["task_a"]);
  });

  it("unchecking affects only the selected task", () => {
    const both = toggleConfirmed(toggleConfirmed(EMPTY_CONFIRMED, "task_a", true), "task_b", true);
    expect(both.size).toBe(2);
    const after = toggleConfirmed(both, "task_a", false);
    expect(isConfirmed(after, "task_a")).toBe(false);
    expect(isConfirmed(after, "task_b")).toBe(true);
  });

  it("state updates are immutable without modifying original set", () => {
    const before: ConfirmedTasks = EMPTY_CONFIRMED;
    const next = toggleConfirmed(before, "task_a", true);
    expect(next).not.toBe(before);
    expect(before.size).toBe(0);
    // 重复勾选同一个任务得到等价的集合，但仍是新对象。
    const again = toggleConfirmed(next, "task_a", true);
    expect([...again]).toEqual(["task_a"]);
  });

  it("unchecking an unconfirmed task is idempotent", () => {
    const next = toggleConfirmed(EMPTY_CONFIRMED, "task_b", false);
    expect(next.size).toBe(0);
  });
});
