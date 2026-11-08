/**
 * 任务分派的生命周期与锁。遵循并发与数据隔离设计的四种结果、P2-1。
 *
 * 写入型任务分派会先拿工作区写锁，再拍快照、写 `delegation/spawn`。
 * 早期 `delegation/spawn` 的 append 在 try 之外：日志写失败（storage_failed）时
 * 异常直接冒出 execute()，锁永远不释放 —— 这个工作区在本次运行里再也派不出写入型任务。
 */

import { closeSync, fsyncSync, fstatSync, ftruncateSync, writeFileSync, writeSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LogIo } from "../../src/host/session/log.js";
import { DelegationRunner } from "../../src/host/delegation/run.js";
import { ProviderSelect } from "../../src/host/delegation/provider-select.js";
import { WorkspaceLocks } from "../../src/host/workspace/locks.js";
import { SessionStore } from "../../src/host/session/store.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { isRpcFailure } from "../../src/host/boot/failure.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

/** 第 N 次写入就抛错的 LogIo：用来把"写日志失败"精确安排在某一条 append 上。 */
function failingIo(failAt: number): LogIo {
  let writes = 0;
  return {
    size(fd) {
      return fstatSync(fd).size;
    },
    write(fd, buf, offset, length, position) {
      writes += 1;
      if (writes === failAt) throw new Error("磁盘满了（注入）");
      return writeSync(fd, buf, offset, length, position);
    },
    truncate(fd, size) {
      ftruncateSync(fd, size);
    },
    rewrite(file, content) {
      writeFileSync(file, content, "utf8");
    },
    fsync(fd) {
      fsyncSync(fd);
    },
    close(fd) {
      closeSync(fd);
    },
  };
}

function setup(failAt: number) {
  const home = makeTempHome();
  const store = new SessionStore({ paths: home.paths, logger, logIo: failingIo(failAt) });
  const sessionId = store.create("ws1", "锁泄漏").sessionId;
  const session = store.get(sessionId);
  const locks = new WorkspaceLocks();
  const select = new ProviderSelect([
    {
      id: "codex",
      label: "Codex",
      entries: [
        {
          level: 1,
          provider: {
            id: "codex",
            capabilities: {
              readOnly: false,
              resume: false,
              effort: false,
              streaming: false,
              receiptStates: ["queued", "submitted", "returned"] as const,
              fragility: "documented" as const,
            },
            detect: async () => ({ installed: true }),
            listSessions: async () => [],
            readSession: async () => [],
            delegate: async () => ({ status: "ok", answer: "好", durationMs: 1 }),
            cancel: async () => undefined,
          },
        },
      ],
      probe: {
        providerId: "probe",
        locate: async () => null,
        listSessions: async () => [],
        readSession: async () => [],
      },
    },
  ]);
  const runner = new DelegationRunner({ select, locks, logger });
  return {
    home,
    session,
    locks,
    runner,
    cleanup: () => {
      store.closeAll();
      home.cleanup();
    },
  };
}

describe("Workspace Lock Release on Dispatch Failure", () => {
  it("releases workspace lock and throws error when session log append fails", async () => {
    // 第 1 次写 = snapshot/taken，第 2 次 = delegation/spawn。
    const fixture = setup(2);
    try {
      let caught: unknown = null;
      try {
        await fixture.runner.dispatch({
          session: fixture.session,
          workspaceId: "ws1",
          workspacePath: fixture.home.home,
          agentId: "codex",
          goal: "改文案",
          instruction: "",
          mode: "write",
          taskType: "general",
          signal: new AbortController().signal,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeNull();
      expect(isRpcFailure(caught)).toBe(true);
      if (isRpcFailure(caught)) {
        expect(caught.code).toBe("storage_failed");
        expect(caught.message).toContain("写日志失败");
      }
      // 关键：锁不能留在 held 里。
      expect(fixture.locks.isWriteLocked("ws1")).toBe(false);
      expect(fixture.runner.inflightIds()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("releases workspace lock even when snapshot creation fails", async () => {
    // 第 1 次写 = snapshot/taken 就失败。
    const fixture = setup(1);
    try {
      let caught: unknown = null;
      try {
        await fixture.runner.dispatch({
          session: fixture.session,
          workspaceId: "ws1",
          workspacePath: fixture.home.home,
          agentId: "codex",
          goal: "改文案",
          instruction: "",
          mode: "write",
          taskType: "general",
          signal: new AbortController().signal,
        });
      } catch (error) {
        caught = error;
      }
      expect(isRpcFailure(caught)).toBe(true);
      expect(fixture.locks.isWriteLocked("ws1")).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });
});
