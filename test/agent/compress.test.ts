/**
 * 上下文压缩与共享上下文。
 */

import { describe, expect, it } from "vitest";
import { activeSummary, buildTurnContext } from "../../src/host/agent/context.js";
import { compressionCut, estimateTokens, summarize, transcriptFor } from "../../src/host/agent/compress.js";
import { sharedContextFor } from "../../src/host/index.js";
import { createMockClient } from "../../src/host/models/llm.js";
import type { Capsule } from "../../src/shared/domain/capsule.js";
import { SessionDerivation } from "../../src/shared/session/derive.js";
import type { SessionEvent } from "../../src/shared/session/events.js";
import { diffShape, shapeOf } from "../../src/shared/session/shape.js";

const at = (seq: number): string => new Date(1_700_000_000_000 + seq * 1000).toISOString();
const user = (seq: number, text: string): SessionEvent => ({ seq, at: at(seq), type: "user/message", text, attachments: [] }) as SessionEvent;
const reply = (seq: number, text: string): SessionEvent => ({ seq, at: at(seq), type: "assistant/message", step: 0, text }) as SessionEvent;
const summary = (seq: number, throughSeq: number, text: string): SessionEvent => ({ seq, at: at(seq), type: "context/summary", throughSeq, text }) as SessionEvent;

describe("Log Format Guard", () => {
  it("allows loading older logs when new unknown event types are added", () => {
    const current = shapeOf();
    const older = current.split(";").filter((part) => !part.startsWith("context/summary:")).join(";");
    expect(diffShape(older, current)).toBeNull();
  });

  it("rejects loading when existing event fields are modified or missing", () => {
    const current = shapeOf();
    const changed = current.replace("user/message:seq,at,text,attachments", "user/message:seq,at,text");
    expect(diffShape(changed, current)).not.toBeNull();
  });
});

describe("Context Summarization", () => {
  const events = [user(1, "第一件事"), reply(2, "做完了"), user(3, "第二件事"), reply(4, "也做完了"), summary(5, 2, "- 第一件事已完成"), user(6, "第三件事")];

  it("replaces compressed history with system prompt summary instead of raw messages", () => {
    const messages = buildTurnContext({ events, system: "SYS", rewind: null });
    const contents = messages.map((message) => message.content);
    expect(contents).not.toContain("第一件事");
    expect(contents).toContain("第二件事");
    expect(contents.some((text) => text.includes("- 第一件事已完成"))).toBe(true);
  });

  it("invalidates summary when rewinding before summarized range", () => {
    expect(activeSummary(events, null)?.throughSeq).toBe(2);
    expect(activeSummary(events, { toSeq: 1, seq: 7 })).toBeNull();
  });

  it("injects shared context capsules as system prompt messages", () => {
    const messages = buildTurnContext({ events: [user(1, "你好")], system: "SYS", rewind: null, shared: "## 约定\n用 pnpm" });
    expect(messages[1]?.content).toContain("用 pnpm");
  });
});

describe("Compression Cut Point and Summary", () => {
  const events = [user(1, "一"), reply(2, "1"), user(3, "二"), reply(4, "2"), user(5, "三"), reply(6, "3"), user(7, "四")];

  it("retains the two most recent user messages and subsequent turns", () => {
    expect(compressionCut(events, null)).toBe(4);
  });

  it("skips recompressing ranges already covered by existing summary", () => {
    expect(compressionCut([...events, summary(8, 4, "s")], null)).toBeNull();
  });

  it("transcripts include only messages prior to compression cut point", () => {
    const transcript = transcriptFor(events, null, 4);
    expect(transcript).toContain("一");
    expect(transcript).toContain("二");
    expect(transcript).not.toContain("四");
  });

  it("estimates token budget using word count for CJK and character ratios for Latin text", () => {
    expect(estimateTokens([{ role: "user", content: "你好世界" }])).toBe(4 + 4);
    expect(estimateTokens([{ role: "user", content: "abcdefgh" }])).toBe(2 + 4);
  });

  it("invokes active model to generate summary or degrades to null when empty", async () => {
    expect(await summarize(createMockClient([{ text: "- 摘要" }]), "user: 一", new AbortController().signal)).toBe("- 摘要");
    expect(await summarize(createMockClient([{ text: "" }]), "user: 一", new AbortController().signal)).toBeNull();
  });
});

describe("Shared Context", () => {
  const capsule = (over: Partial<Capsule>): Capsule => ({
    capsuleId: "c",
    title: "约定",
    humanSummary: "用 pnpm",
    technicalHandoff: "",
    touchedFiles: [],
    scope: "workspace",
    sessionId: "other",
    workspaceId: "ws",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

  it("injects only capsules from external sessions, workspace-level, or prior to session start", () => {
    const text = sharedContextFor(
      [
        capsule({ capsuleId: "a", title: "带入" }),
        capsule({ capsuleId: "b", title: "本对话自己的", sessionId: "me" }),
        capsule({ capsuleId: "c", title: "仅对话级", scope: "chat" }),
        capsule({ capsuleId: "d", title: "开始后才存", createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" }),
        capsule({ capsuleId: "e", title: "开始前存、开始后编辑", updatedAt: "2026-06-01T00:00:00.000Z" }),
      ],
      "me",
      "2026-03-01T00:00:00.000Z",
    );
    expect(text).toContain("带入");
    expect(text).not.toContain("本对话自己的");
    expect(text).not.toContain("仅对话级");
    expect(text).not.toContain("开始后才存");
    expect(text).toContain("开始前存、开始后编辑");
  });

  it("removes deleted capsules from derived view", () => {
    const derivation = new SessionDerivation({ sessionId: "s", workspaceId: "ws" });
    const saved = { at: at(1), capsuleId: "x", title: "t", humanSummary: "h", technicalHandoff: "", touchedFiles: [], scope: "workspace" };
    derivation.apply({ ...saved, seq: 1, type: "capsule/saved", action: "create" } as SessionEvent);
    expect(derivation.view().capsules).toHaveLength(1);
    derivation.apply({ ...saved, seq: 2, type: "capsule/saved", action: "remove" } as SessionEvent);
    expect(derivation.view().capsules).toHaveLength(0);
  });
});
