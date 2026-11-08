import { describe, expect, it } from "vitest";
import { buildDelegationPrompt } from "../../src/host/delegation/prompt.js";
import { buildSystemPrompt } from "../../src/host/agent/prompt/system.js";
import type { DelegationRequest } from "../../src/shared/domain/delegation.js";

const request: DelegationRequest = { childId: "1", agentId: "opencode", workspace: "D:/project", goal: "继续\n用户原话  ", instruction: "核查上一步发现：a.ts:12，并提出修复。", mode: "write", taskType: "review", signal: new AbortController().signal, onEvent: () => {} };

describe("delegation prompts", () => {
  it("sends only the assigned task without adding user-message or workspace boilerplate", () => {
    const prompt = buildDelegationPrompt(request);
    expect(prompt).toBe(request.instruction);
    expect(prompt).not.toContain(request.goal);
    expect(prompt).not.toContain(request.workspace);
  });

  it("does not append mode or sandbox wording; the host enforces permissions", () => {
    const prompt = buildDelegationPrompt({ ...request, goal: "检查", instruction: "检查 README", mode: "read-only" });
    expect(prompt).toBe("检查 README");
    expect(prompt).not.toMatch(/read-only|只读/i);
  });

  it("falls back to the original task when there is no separate assignment", () => {
    expect(buildDelegationPrompt({ ...request, instruction: "" })).toBe(request.goal);
  });

  it("uses one English coordinator template while preserving staged handoff and permissions", () => {
    const input = { workspacePath: "D:/project", toolNames: ["dispatch_task"], model: "example" };
    const zh = buildSystemPrompt({ ...input, language: "zh-CN" });
    const en = buildSystemPrompt({ ...input, language: "en" });
    expect(en).toBe(zh);
    expect(zh).toContain("context_task_ids");
    expect(zh).toContain("do not impose read-only");
    expect(zh).toContain("do not add redundant roles");
    // 写作要求：校验系统提示词中包含对常见负面套话模式的过滤规则。
    expect(zh).toContain("不是……而是……");
    expect(zh).toContain("兜底");
    expect(zh).toContain("Do not rank agents");
  });
});
