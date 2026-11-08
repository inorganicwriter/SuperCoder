/**
 * 进程在回合中途退出后再启动：上次的回合要被收尾。
 *
 * 曾经的表现：重启后审批卡片还在，点允许/拒绝都没反应（宿主内存里已经没有这条审批），
 * 会话一直显示"执行中"。
 */

import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/host/boot/logger.js";
import { SessionStore } from "../../src/host/session/store.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

describe("Finalize Incomplete Turns on Startup", () => {
  it("marks pending approvals voided, turn interrupted, and session idle when exiting during approval", () => {
    const home = makeTempHome();
    const first = new SessionStore({ paths: home.paths, logger });
    try {
      const id = first.create("ws", "t").sessionId;
      const session = first.get(id);
      session.append("turn/start", { chatId: id });
      session.append("user/message", { text: "测试一下工具", attachments: [] });
      session.append("tool/call", { callId: "c1", name: "run_workspace_verification", args: {} });
      session.append("tool/approval-requested", { callId: "c1" });
      first.closeAll();

      const second = new SessionStore({ paths: home.paths, logger });
      try {
        second.scanAll();
        const view = second.get(id).view();
        expect(view.tools[0]?.state).toBe("error");
        expect(view.pending).toEqual([]);
        expect(view.status).toBe("idle");
        const last = second.get(id).allEvents().at(-1);
        expect(last).toMatchObject({ type: "turn/end", status: "interrupted", reason: "process_exit" });
        // 再扫一次不会重复补写。
        const count = second.get(id).allEvents().length;
        second.closeAll();
        const third = new SessionStore({ paths: home.paths, logger });
        third.scanAll();
        expect(third.get(id).allEvents().length).toBe(count);
        third.closeAll();
      } finally {
        second.closeAll();
      }
    } finally {
      first.closeAll();
      home.cleanup();
    }
  });

  it("marks running tasks and turns as unknown when host terminates abnormally", () => {
    const home = makeTempHome();
    const first = new SessionStore({ paths: home.paths, logger });
    try {
      const id = first.create("ws", "t").sessionId;
      const session = first.get(id);
      session.append("turn/start", { chatId: id });
      session.append("delegation/spawn", { childId: "k1", provider: "codex", agentId: "codex", goal: "改", instruction: "", mode: "write" });
      session.append("delegation/delivery", { childId: "k1", state: "submitted" });
      first.closeAll();

      const second = new SessionStore({ paths: home.paths, logger });
      try {
        second.scanAll();
        const view = second.get(id).view();
        expect(view.tasks[0]?.state).toBe("unknown");
        expect(second.get(id).allEvents().at(-1)).toMatchObject({ type: "turn/end", status: "unknown" });
      } finally {
        second.closeAll();
      }
    } finally {
      first.closeAll();
      home.cleanup();
    }
  });
});
