/**
 * 存储与通道：日志、崩溃修复、字段守卫、索引重建、会话打开时间。
 * 会话持久化与崩溃恢复测试规范。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/shared/session/events.js";
import { diffShape, shapeOf } from "../../src/shared/session/shape.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { sessionIndexFile, sessionLogFile } from "../../src/host/boot/paths.js";
import { SessionHandle } from "../../src/host/session/handle.js";
import { openLog } from "../../src/host/session/log.js";
import { loadLog, readHeader } from "../../src/host/session/reader.js";
import { SessionStore } from "../../src/host/session/store.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

function newStore(home: ReturnType<typeof makeTempHome>): SessionStore {
  return new SessionStore({ paths: home.paths, logger });
}

/** 造一份有代表性的历史：用户消息、助手回复、工具调用、委派、胶囊。 */
function seed(store: SessionStore, sessionId: string, count: number): void {
  const handle = store.get(sessionId);
  handle.append("turn/start", { chatId: sessionId });
  for (let index = 0; index < count; index += 1) {
    const step = index % 4;
    if (step === 0) {
      handle.append("user/message", { text: `问题 ${index}`, attachments: [] });
    } else if (step === 1) {
      handle.append("assistant/message", { step: index, text: `回答 ${index}` });
    } else if (step === 2) {
      handle.append("tool/call", {
        callId: `call-${index}`,
        name: "query_task_status",
        args: { task_id: `t-${index}` },
      });
    } else {
      handle.append("tool/result", {
        callId: `call-${index}`,
        outcome: { status: "ok", value: { index } },
      });
    }
  }
  handle.append("capsule/saved", {
    capsuleId: "cap-1",
    action: "create",
    title: "交接",
    humanSummary: "摘要",
    technicalHandoff: "细节",
    touchedFiles: ["src/a.ts"],
    scope: "chat",
  });
  handle.append("delegation/spawn", {
    childId: "task-1",
    provider: "codex",
    agentId: "codex",
    instruction: "补一句",
    goal: "用户原话",
    mode: "read-only",
  });
  handle.append("delegation/delivery", { childId: "task-1", state: "queued" });
  handle.append("delegation/result", {
    childId: "task-1",
    result: { status: "unknown", observed: "进程已退出", since: "2026-01-01T00:00:00.000Z" },
  });
  handle.append("turn/end", { status: "completed" });
  handle.writeIndex();
}

describe("Log Storage and Indexing Mechanism", () => {
  it("reproduces identical field-by-field projection after 10k events across restart", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "验收会话");
      seed(store, sessionId, 9_996);
      const handle = store.get(sessionId);
      const before = handle.view();
      expect(before.lastSeq).toBeGreaterThanOrEqual(10_000);
      store.closeAll();

      const reopened = newStore(home);
      const again = reopened.get(sessionId).view();
      expect(JSON.stringify(again)).toBe(JSON.stringify(before));
      expect(again.counts.user).toBe(2_499);
      expect(again.counts.tool).toBe(2_499);
      expect(again.tasks[0]?.state).toBe("unknown");
      reopened.closeAll();
    } finally {
      home.cleanup();
    }
  });

  it("reconstructs exact state from log after deleting index.json", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "索引可丢");
      seed(store, sessionId, 400);
      const before = JSON.stringify(store.get(sessionId).view());
      store.closeAll();

      rmSync(sessionIndexFile(home.paths, sessionId), { force: true });
      expect(existsSync(sessionIndexFile(home.paths, sessionId))).toBe(false);

      const reopened = newStore(home);
      const after = JSON.stringify(reopened.get(sessionId).view());
      expect(after).toBe(before);
      reopened.closeAll();
    } finally {
      home.cleanup();
    }
  });

  it("opens session with 10k events within 150ms budget", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1");
      seed(store, sessionId, 9_996);
      store.closeAll();

      const started = process.hrtime.bigint();
      const reopened = newStore(home);
      const handle = reopened.get(sessionId);
      const view = handle.view();
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(view.lastSeq).toBeGreaterThanOrEqual(10_000);
      expect(elapsedMs).toBeLessThan(150);
      reopened.closeAll();
    } finally {
      home.cleanup();
    }
  });

  it("auto-repairs truncated trailing line and emits session/repaired event", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1");
      seed(store, sessionId, 40);
      store.closeAll();

      const logFile = sessionLogFile(home.paths, sessionId);
      const original = readFileSync(logFile, "utf8");
      const truncated = original.slice(0, original.length - 30);
      writeFileSync(logFile, truncated, "utf8");

      const reopened = newStore(home);
      const handle = reopened.get(sessionId);
      const repaired = handle.view();
      const repairedEvents = handle.allEvents().filter((event) => event.type === "session/repaired");
      expect(repairedEvents).toHaveLength(1);
      expect(repairedEvents[0]?.type === "session/repaired" && repairedEvents[0].truncatedBytes).toBeGreaterThan(0);
      // 截断前的历史仍然完整可读
      expect(repaired.messages.length).toBeGreaterThan(0);

      // 修复后的文件以换行结尾，且修复记录本身也落了盘
      const bytes = readFileSync(logFile);
      expect(bytes[bytes.length - 1]).toBe(0x0a);
      const reloaded = loadLog(logFile, { repair: false });
      expect(reloaded.ok).toBe(true);
      reopened.closeAll();
    } finally {
      home.cleanup();
    }
  });

  it("rejects incompatible shape with actionable diagnostic message", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1");
      seed(store, sessionId, 12);
      store.closeAll();

      const logFile = sessionLogFile(home.paths, sessionId);
      const lines = readFileSync(logFile, "utf8").split("\n");
      const header = JSON.parse(lines[0] ?? "{}") as { kind: string; fields: string; meta: unknown };
      // 模拟"改掉 shapeOf() 的一个字段名"之后读旧日志的情形
      const drifted = {
        ...header,
        fields: header.fields.replace("user/message:seq,at,text,attachments", "user/message:seq,at,body,attachments"),
      };
      lines[0] = JSON.stringify(drifted);
      writeFileSync(logFile, lines.join("\n"), "utf8");

      const loaded = loadLog(logFile, { repair: false });
      expect(loaded.ok).toBe(false);
      if (loaded.ok) throw new Error("应当拒绝加载");
      expect(loaded.error.code).toBe("shape_mismatch");
      expect(loaded.error.message).toContain("body");
      expect(loaded.error.message).toContain("少了");
      expect(loaded.error.hint).toContain("重建");

      const headerOnly = readHeader(logFile);
      expect(headerOnly.ok).toBe(false);

      const opened = SessionHandle.open({
        sessionId,
        meta: { title: "x", createdAt: "2026-01-01T00:00:00.000Z", workspace: "ws-1", language: "zh-CN" },
        workspaceId: "ws-1",
        logFile,
        indexPath: sessionIndexFile(home.paths, sessionId),
      });
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.error.code).toBe("shape_mismatch");
    } finally {
      home.cleanup();
    }
  });

  it("second writer on same session receives busy error", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1");
      const handle = store.get(sessionId);
      handle.beginTurn("turn-1");
      expect(() => handle.beginTurn("turn-2")).toThrowError(/正在执行回合/);
      handle.endTurn();
      expect(() => handle.beginTurn("turn-3")).not.toThrow();
      handle.endTurn();
      store.closeAll();
    } finally {
      home.cleanup();
    }
  });

  it("describes shape differences highlighting added and missing fields", () => {
    const current = shapeOf();
    const recorded = current
      .replace("tool/call:seq,at,callId,name,args", "tool/call:seq,at,callId,name,arguments")
      .replace("capsule/saved:", "capsule/saved:extraField,");
    const drift = diffShape(recorded, current);
    expect(drift).toContain("tool/call");
    expect(drift).toContain("arguments");
    expect(drift).toContain("capsule/saved");
  });

  it("renaming only updates header metadata while keeping lines readable", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "旧标题");
      seed(store, sessionId, 20);
      const bodyLinesBefore = readFileSync(sessionLogFile(home.paths, sessionId), "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .slice(1);
      store.rename(sessionId, "新标题");
      const text = readFileSync(sessionLogFile(home.paths, sessionId), "utf8");
      const lines = text.split("\n").filter((line) => line !== "");
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({ kind: "header", meta: { title: "新标题" } });
      expect(lines.slice(1)).toEqual(bodyLinesBefore);
      const summary = store.get(sessionId).summary();
      expect(summary.title).toBe("新标题");
      store.closeAll();
    } finally {
      home.cleanup();
    }
  });

  it("session.rebuild generates summary even when index is missing", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "重建");
      seed(store, sessionId, 60);
      store.closeAll();
      rmSync(sessionIndexFile(home.paths, sessionId), { force: true });

      const reopened = newStore(home);
      const summary = reopened.rebuild(sessionId);
      expect(summary.sessionId).toBe(sessionId);
      expect(summary.title).toBe("重建");
      expect(existsSync(sessionIndexFile(home.paths, sessionId))).toBe(true);
      reopened.closeAll();
    } finally {
      home.cleanup();
    }
  });

  it("new log starts with header and continuous sequence numbers from 1", () => {
    const home = makeTempHome();
    try {
      const file = join(home.paths.sessionsDir, "manual", "log.jsonl");
      const opened = openLog(file, {
        title: "手动",
        createdAt: "2026-01-01T00:00:00.000Z",
        workspace: "ws",
        language: "zh-CN",
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error("openLog 失败");
      opened.value.log.append("turn/start", { chatId: "c" });
      opened.value.log.append("turn/end", { status: "completed" });
      opened.value.log.close();
      const loaded = loadLog(file);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error("loadLog 失败");
      expect(loaded.value.events.map((event: SessionEvent) => event.seq)).toEqual([1, 2]);
      expect(loaded.value.header.fields).toBe(shapeOf());
    } finally {
      home.cleanup();
    }
  });
});
