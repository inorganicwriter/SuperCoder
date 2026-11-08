/**
 * 落盘确认失败时，内存与日志必须保持一致。遵循架构设计规范。
 *
 * `Log.append` 先写行、再 fsync。fsync 抛错时那行**已经在文件里了**（页缓存），
 * 但 `SessionHandle.append` 在 `log.append` 抛出后就没往下走：不 push、不投影、不通知。
 * 于是磁盘上有 seq N，内存里没有；下一条事件内存记成 N+1，disk 也是 N+1 但少了 N 的投影 ——
 * 界面看不到那条消息，重启后它又冒出来（"幽灵消息"）。
 */

import { closeSync, fstatSync, fsyncSync, ftruncateSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LogIo } from "../../src/host/session/log.js";
import { SessionStore } from "../../src/host/session/store.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { isRpcFailure } from "../../src/host/boot/failure.js";
import { sessionLogFile } from "../../src/host/boot/paths.js";
import type { SessionEvent } from "../../src/shared/session/events.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

/** fsync 可以被掐一次；其余照常。 */
function flakyFsync(): { io: LogIo; breakNextFsync: () => void } {
  let fail = false;
  const io: LogIo = {
    size(fd) {
      return fstatSync(fd).size;
    },
    write(fd, buf, offset, length, position) {
      return writeSync(fd, buf, offset, length, position);
    },
    truncate(fd, size) {
      ftruncateSync(fd, size);
    },
    rewrite(file, content) {
      writeFileSync(file, content, "utf8");
    },
    fsync(fd) {
      if (fail) {
        fail = false;
        throw new Error("fsync 失败（注入）");
      }
      fsyncSync(fd);
    },
    close(fd) {
      closeSync(fd);
    },
  };
  return {
    io,
    breakNextFsync: () => {
      fail = true;
    },
  };
}

function diskEvents(file: string): SessionEvent[] {
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
  // 首行是 meta，其余每行一条事件。
  return lines.slice(1).map((line) => JSON.parse(line) as SessionEvent);
}

describe("handles storage fsync failures with rollback and clear error", () => {
  it("retains event in memory projection while returning storage_failed", () => {
    const home = makeTempHome();
    const { io, breakNextFsync } = flakyFsync();
    try {
      const store = new SessionStore({ paths: home.paths, logger, logIo: io });
      const { sessionId } = store.create("ws1", "落盘失败");
      const session = store.get(sessionId);
      session.append("user/message", { text: "第一条", attachments: [] });

      // 数到 5 条就会在 append 里同步 fsync：把这一枪打成失败。
      breakNextFsync();
      let caught: unknown = null;
      try {
        for (let index = 0; index < 5; index += 1) {
          session.append("user/message", { text: `第 ${String(index + 2)} 条`, attachments: [] });
        }
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeNull();
      expect(isRpcFailure(caught)).toBe(true);
      if (isRpcFailure(caught)) {
        expect(caught.code).toBe("storage_failed");
        expect(caught.message).toContain("未确认落盘");
        // 报错带着"已经写进去的那条事件"，供上层补偿。
        expect(caught.writtenEvent).toBeDefined();
      }

      const events = session.allEvents();
      const disk = diskEvents(sessionLogFile(home.paths, sessionId));
      // 关键：内存里的 seq 与磁盘一致，一条都不能少。
      expect(events.map((event) => event.seq)).toEqual(disk.map((event) => event.seq));
      expect(events).toHaveLength(disk.length);
      store.closeAll();
    } finally {
      home.cleanup();
    }
  });

  it("keeps projection updated with message text searchable in view", () => {
    const home = makeTempHome();
    const { io, breakNextFsync } = flakyFsync();
    try {
      const store = new SessionStore({ paths: home.paths, logger, logIo: io });
      const { sessionId } = store.create("ws1", "投影一致");
      const session = store.get(sessionId);
      session.append("user/message", { text: "起手", attachments: [] });
      breakNextFsync();
      try {
        for (let index = 0; index < 5; index += 1) {
          session.append("user/message", { text: `消息${String(index)}`, attachments: [] });
        }
      } catch {
        // 预期之内：fsync 那一枪失败了。
      }
      const texts = session.allEvents().map((event) => (event.type === "user/message" ? event.text : ""));
      // 第 5 条（起手 + 4 条消息）正是"写完之后 fsync 才失败"的那条，必须在内存里。
      expect(texts.filter((text) => text !== "")).toEqual(["起手", "消息0", "消息1", "消息2", "消息3"]);
      expect(session.lastSeq).toBe(5);
      store.closeAll();
    } finally {
      home.cleanup();
    }
  });
});
