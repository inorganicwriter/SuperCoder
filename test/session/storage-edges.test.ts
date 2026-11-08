/**
 * 存储边界处理与故障注入测试。
 *
 * 每条对应一种"日志是对的、但外面的世界不按剧本来"的情形：
 * 跳号、坏行、超长事件、时间倒退、索引指向已删日志、写盘失败。
 * 判据只有一条：**失败要明说，绝不静默**。
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/host/boot/logger.js";
import { isRpcFailure } from "../../src/host/boot/failure.js";
import { sessionIndexFile, sessionLogFile } from "../../src/host/boot/paths.js";
import { startHost } from "../../src/host/index.js";
import type { LogIo } from "../../src/host/session/log.js";
import { WorkspacesStore } from "../../src/host/boot/config.js";
import { WorkspaceRegistry } from "../../src/host/workspace/entity.js";
import { SessionStore } from "../../src/host/session/store.js";
import type { SessionEvent } from "../../src/shared/session/events.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

type TempHome = ReturnType<typeof makeTempHome>;

function newStore(home: TempHome): SessionStore {
  return new SessionStore({ paths: home.paths, logger });
}

function bodyLines(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 把日志正文（首行之后）整体替换成给定的各行。 */
function rewriteBody(file: string, lines: readonly string[]): void {
  const header = bodyLines(file)[0] ?? "";
  writeFileSync(file, `${[header, ...lines].join("\n")}\n`, "utf8");
}

/** 打开必须失败：把抛出来的错误当返回值，方便断言。 */
function openError(store: SessionStore, sessionId: string): unknown {
  try {
    store.get(sessionId);
    return null;
  } catch (reason) {
    return reason;
  }
}

describe("Storage Boundaries", () => {
  it("rejects loading with line number when sequence numbers skip", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "跳号");
      const handle = store.get(sessionId);
      handle.append("user/message", { text: "第一条", attachments: [] });
      handle.append("user/message", { text: "第二条", attachments: [] });
      handle.append("user/message", { text: "第三条", attachments: [] });
      store.closeAll();

      const file = sessionLogFile(home.paths, sessionId);
      const lines = bodyLines(file).slice(1);
      const third = JSON.parse(lines[2] ?? "{}") as { seq: number };
      third.seq = 5; // 中间少了一个 4
      rewriteBody(file, [lines[0] ?? "", lines[1] ?? "", JSON.stringify(third)]);

      const error = openError(newStore(home), sessionId);
      expect(isRpcFailure(error)).toBe(true);
      if (isRpcFailure(error)) {
        expect(error.code).toBe("storage_failed");
        expect(error.message).toContain("seq 是 5");
        expect(error.message).toContain("应为 3");
        expect(error.message).toBeTruthy();
      }
    } finally {
      home.cleanup();
    }
  });

  it("rejects loading with line number when middle line JSON is corrupted", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "坏行");
      const handle = store.get(sessionId);
      for (let index = 0; index < 5; index += 1) {
        handle.append("user/message", { text: `第 ${String(index)} 条`, attachments: [] });
      }
      store.closeAll();

      const file = sessionLogFile(home.paths, sessionId);
      const lines = bodyLines(file);
      lines[3] = '{"type": "user/message", "seq": 3, '; // 第 4 行（首行是 header）
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

      const error = openError(newStore(home), sessionId);
      expect(isRpcFailure(error)).toBe(true);
      if (isRpcFailure(error)) {
        expect(error.code).toBe("storage_failed");
        expect(error.message).toContain("第 4 行");
      }
      // 坏行在中间：不会被当成"末行截断"而被静默修掉。
      expect(bodyLines(file).length).toBe(6);
    } finally {
      home.cleanup();
    }
  });

  it("persists and reads 10MB large event without payload truncation", () => {
    const home = makeTempHome();
    try {
      const text = "x".repeat(10 * 1024 * 1024);
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "长文本");
      store.get(sessionId).append("user/message", { text, attachments: [] });
      store.closeAll();

      expect(readFileSync(sessionLogFile(home.paths, sessionId), "utf8").length).toBeGreaterThan(
        text.length,
      );

      const reopened = newStore(home);
      const readBack = reopened.get(sessionId).view().messages[0];
      expect(readBack?.text.length).toBe(text.length);
      expect(readBack?.text).toBe(text);
      reopened.closeAll();
    } finally {
      home.cleanup();
    }
  }, 60_000);

  it("handles backward timestamps gracefully ordering events strictly by seq", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "时间倒退");
      const handle = store.get(sessionId);
      handle.append("user/message", { text: "新", attachments: [] });
      handle.append("assistant/message", { step: 1, text: "更早的时间" });
      store.closeAll();

      const file = sessionLogFile(home.paths, sessionId);
      const lines = bodyLines(file);
      const second = JSON.parse(lines[2] ?? "{}") as SessionEvent;
      lines[2] = JSON.stringify({ ...second, at: "2000-01-01T00:00:00.000Z" });
      writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

      const reopened = newStore(home);
      const view = reopened.get(sessionId).view();
      expect(view.messages.map((message) => message.seq)).toEqual([1, 2]);
      expect(view.messages[1]?.text).toBe("更早的时间");
      expect(view.lastSeq).toBe(2);
      reopened.closeAll();
    } finally {
      home.cleanup();
    }
  });

  it("appends new messages following rewind without reviving pruned history", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "回撤后继续");
      const handle = store.get(sessionId);
      const first = handle.append("user/message", { text: "问题一", attachments: [] });
      handle.append("assistant/message", { step: 1, text: "回答一" });
      handle.append("assistant/message", { step: 1, text: "回答二" });
      handle.append("user/rewind", { toSeq: first.seq });
      const after = handle.append("user/message", { text: "问题二", attachments: [] });

      const view = handle.view();
      expect(view.messages.map((message) => message.text)).toEqual(["问题一", "问题二"]);
      expect(view.messages[view.messages.length - 1]?.seq).toBe(after.seq);
      store.closeAll();

      // 重启后按同一规则重算，结果必须一致。
      const again = newStore(home).get(sessionId).view();
      expect(again.messages.map((message) => message.text)).toEqual(["问题一", "问题二"]);
    } finally {
      home.cleanup();
    }
  });

  it("omits missing log from session list and returns not_found on open", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "日志被删");
      store.get(sessionId).append("user/message", { text: "在吗", attachments: [] });
      store.closeAll();
      expect(existsSync(sessionIndexFile(home.paths, sessionId))).toBe(true);
      rmSync(sessionLogFile(home.paths, sessionId), { force: true });

      const reopened = newStore(home);
      expect(reopened.listSessionIds()).toEqual([]);
      expect(reopened.list("")).toEqual([]);
      expect(reopened.summaryOf(sessionId)).toBeNull();
      const error = openError(reopened, sessionId);
      expect(isRpcFailure(error)).toBe(true);
      if (isRpcFailure(error)) {
        expect(error.code).toBe("not_found");
        expect(error.message).toBeTruthy();
      }
    } finally {
      home.cleanup();
    }
  });

  it("reads updated title and complete body after atomic header rename", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "旧名字");
      const handle = store.get(sessionId);
      for (let index = 0; index < 5; index += 1) {
        handle.append("user/message", { text: `第 ${String(index)} 条`, attachments: [] });
      }
      handle.rename("新名字");
      store.closeAll();

      const before = bodyLines(sessionLogFile(home.paths, sessionId));
      const reopened = newStore(home);
      const again = reopened.get(sessionId);
      expect(again.meta.title).toBe("新名字");
      expect(again.allEvents()).toHaveLength(5);
      expect(bodyLines(sessionLogFile(home.paths, sessionId))).toEqual(before);
      reopened.closeAll();
    } finally {
      home.cleanup();
    }
  });

  it("rejects loading zero-byte empty file with missing header error", () => {
    const home = makeTempHome();
    try {
      const store = newStore(home);
      const { sessionId } = store.create("ws-1", "空日志");
      store.get(sessionId).append("user/message", { text: "在吗", attachments: [] });
      store.closeAll();
      writeFileSync(sessionLogFile(home.paths, sessionId), "", "utf8");

      const error = openError(newStore(home), sessionId);
      expect(isRpcFailure(error)).toBe(true);
      if (isRpcFailure(error)) {
        expect(error.code).toBe("storage_failed");
        expect(error.message).toContain("没有头部");
      }
    } finally {
      home.cleanup();
    }
  });
});

describe("Rename Failure Handling", () => {
  it("keeps original title in index and preserves body when metadata update fails", () => {
    const home = makeTempHome();
    try {
      const seedStore = newStore(home);
      const { sessionId } = seedStore.create("ws-1", "旧名字");
      const seedHandle = seedStore.get(sessionId);
      seedHandle.append("user/message", { text: "第一条", attachments: [] });
      seedHandle.append("assistant/message", { step: 1, text: "回答" });
      seedStore.closeAll();

      // 注入一个"整文件重写必失败"的 io：改名走的就是这条路。
      const failing: LogIo = {
        size: (fd) => fstatSync(fd).size,
        write: (fd, buf, offset, length, position) => writeSync(fd, buf, offset, length, position),
        truncate: (fd, size) => {
          ftruncateSync(fd, size);
        },
        rewrite: () => {
          throw new Error("改元数据失败（注入）");
        },
        fsync: (fd) => {
          fsyncSync(fd);
        },
        close: (fd) => {
          closeSync(fd);
        },
      };

      const store = new SessionStore({ paths: home.paths, logger, logIo: failing });
      const handle = store.get(sessionId);
      const error = (() => {
        try {
          handle.rename("新名字");
          return null;
        } catch (reason) {
          return reason;
        }
      })();
      expect(isRpcFailure(error)).toBe(true);
      if (isRpcFailure(error)) {
        expect(error.code).toBe("storage_failed");
        expect(error.message).toContain("改元数据失败");
      }
      // 索引仍是旧标题：rename 抛错后不该留下"索引说新名字、日志说旧名字"的分裂。
      const index = JSON.parse(
        readFileSync(sessionIndexFile(home.paths, sessionId), "utf8"),
      ) as { header: { title: string } };
      expect(index.header.title).toBe("旧名字");
      // 会话还能继续写。
      expect(handle.append("user/message", { text: "失败之后", attachments: [] }).seq).toBe(3);
      store.closeAll();

      const reopened = newStore(home);
      const again = reopened.get(sessionId);
      expect(again.meta.title).toBe("旧名字");
      expect(again.allEvents().map((event) => event.seq)).toEqual([1, 2, 3]);
      reopened.closeAll();
    } finally {
      home.cleanup();
    }
  });
});

describe("Write Failure Injection", () => {
  it("returns storage_failed without half-lines or sequence gaps on injected write error", async () => {
    const temp = makeTempHome();
    // 先在磁盘上种一条历史，让 host 打开时不用新建（新建会走 writeFileSync，不经 io）。
    // 会话必须挂在一个真实工作区上：工作区不在时回撤会被直接拒绝（not_found），
    // 这条用例要测的是"写日志失败"，所以得先把工作区建出来。
    let sessionId = "";
    let workspaceId = "";
    {
      const workspaces = new WorkspaceRegistry(new WorkspacesStore(temp.paths));
      workspaceId = workspaces.add(temp.home, "临时").id;
      const seedStore = newStore(temp);
      sessionId = seedStore.create(workspaceId, "写失败").sessionId;
      seedStore.get(sessionId).append("user/message", { text: "起手一条", attachments: [] });
      seedStore.closeAll();
    }

    let writes = 0;
    const failing: LogIo = {
      size(fd) {
        return fstatSync(fd).size;
      },
      write(fd, buf, offset, length, position) {
        writes += 1;
        if (writes === 2) throw new Error("磁盘满了（注入）");
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

    const host = await startHost({ home: temp.home, port: 0, logger, logIo: failing });
    try {
      // message.rewind 在 RPC 里同步追加两条：user/rewind 成功、rewind/completed 失败。
      const rewound = await host.rpc("message.rewind", { sessionId, toSeq: 1 });
      expect(rewound.ok).toBe(false);
      if (!rewound.ok) {
        expect(rewound.error.code).toBe("storage_failed");
        expect(rewound.error.message).toContain("写日志失败");
      }

      const file = sessionLogFile(temp.paths, sessionId);
      const afterFailure = bodyLines(file);
      // header + user/message + user/rewind：失败那条一点没写进去，也没有半截行。
      expect(afterFailure).toHaveLength(3);
      for (const line of afterFailure) expect(() => JSON.parse(line) as unknown).not.toThrow();

      // 恢复写盘后再走一次同样的 RPC：seq 从 3 接着来，不跳号（跳号会让下次加载整份拒绝）。
      const again = await host.rpc("message.rewind", { sessionId, toSeq: 1 });
      expect(again.ok).toBe(true);
    } finally {
      await host.close();
    }

    const reopened = newStore(temp);
    try {
      const events = reopened.get(sessionId).allEvents();
      const seqs = events.map((event) => event.seq);
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
      expect(new Set(seqs).size).toBe(seqs.length);
      // 失败那次没落 rewind/completed；成功那次落了恰好一条。
      expect(events.filter((event) => event.type === "rewind/completed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "user/rewind")).toHaveLength(2);
    } finally {
      reopened.closeAll();
      temp.cleanup();
    }
  }, 60_000);
});
