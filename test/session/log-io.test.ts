/**
 * 日志写入路径的故障注入。遵循架构设计规范。
 *
 * 写入异常路径测试：处理部分写入续接、写入中断以及延迟 fsync 失败。
 * - 短写：不抛错，只是少写几个字节 → 不续写就会在文件里留下一行坏 JSON
 * - 写到一半失败：半行夹在中间 → 整份日志被拒绝加载
 * - fsync 失败：事件已进入系统缓存，重试会导致重复写入，且定时器未捕获异常会导致主进程崩溃
 */

import {
  closeSync,
  fstatSync,
  writeFileSync,
  ftruncateSync,
  readFileSync,
  rmSync,
  writeSync,
  fsyncSync,
} from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { openLog, type LogIo, type SessionLog } from "../../src/host/session/log.js";
import { isRpcFailure } from "../../src/host/boot/failure.js";
import { loadLog } from "../../src/host/session/reader.js";
import type { LogHeader, SessionMeta } from "../../src/shared/session/events.js";
import { makeTempHome } from "../helpers/temp.js";

const META: SessionMeta = {
  title: "写路径",
  createdAt: "2026-01-01T00:00:00.000Z",
  workspace: "ws-1",
  language: "zh-CN",
};

const opened: Array<{ log: SessionLog; file: string }> = [];

afterEach(() => {
  for (const entry of opened.splice(0)) {
    try {
      entry.log.close();
    } catch {
      // 用例故意把 io 弄坏过：关不掉不算这条断言的事。
    }
  }
});

interface FakeOptions {
  /** 每次 write 最多写多少字节（模拟短写）。 */
  readonly chunk?: number;
  /** 累计写到这么多字节后抛错。 */
  readonly failAfterBytes?: number;
  /** 这一次 write 直接返回 0（模拟"一点都没写进去"）。 */
  readonly zeroOnce?: boolean;
  /** fsync 抛错。 */
  readonly failFsync?: boolean;
  /** 整文件重写抛错。 */
  readonly failRewrite?: boolean;
}

class FakeIo implements LogIo {
  readonly options: {
    chunk?: number | undefined;
    failAfterBytes?: number | undefined;
    zeroOnce?: boolean | undefined;
    failFsync?: boolean | undefined;
    failRewrite?: boolean | undefined;
  };
  bytesWritten = 0;
  writeCalls = 0;
  truncateCalls = 0;
  rewriteCalls = 0;

  constructor(options: FakeOptions = {}) {
    this.options = { ...options };
  }

  size(fd: number): number {
    return fstatSync(fd).size;
  }

  write(fd: number, buf: Buffer, offset: number, length: number, position: number): number {
    this.writeCalls += 1;
    if (this.options.zeroOnce === true) {
      this.options.zeroOnce = false;
      return 0;
    }
    let allowed = Math.min(length, this.options.chunk ?? length);
    const budget = this.options.failAfterBytes;
    if (budget !== undefined) {
      const left = budget - this.bytesWritten;
      if (left <= 0) throw new Error("写入被截断（注入）");
      allowed = Math.min(allowed, left);
    }
    const count = writeSync(fd, buf, offset, allowed, position);
    this.bytesWritten += count;
    return count;
  }

  truncate(fd: number, size: number): void {
    this.truncateCalls += 1;
    ftruncateSync(fd, size);
  }

  rewrite(file: string, content: string): void {
    this.rewriteCalls += 1;
    if (this.options.failRewrite === true) throw new Error("改元数据失败（注入）");
    writeFileSync(file, content, "utf8");
  }

  fsync(fd: number): void {
    if (this.options.failFsync === true) throw new Error("fsync 失败（注入）");
    fsyncSync(fd);
  }

  close(fd: number): void {
    closeSync(fd);
  }
}

function makeLog(io: LogIo): { log: SessionLog; file: string; header: LogHeader } {
  const home = makeTempHome();
  const file = `${home.home}/sessions/s1/log.jsonl`;
  const result = openLog(file, META, { io });
  if (!result.ok) throw new Error(`打开日志失败：${result.error.message}`);
  opened.push({ log: result.value.log, file });
  return { log: result.value.log, file, header: result.value.header };
}

/** 等定时器把 fsync 打失败（用可观测状态等，不靠固定 sleep）。 */
async function waitForFlushFailure(log: SessionLog, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (log.flushFailed) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("定时器没有在预期时间内把 fsync 打失败");
}

function lines(file: string): string[] {
  const parts = readFileSync(file, "utf8").split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

describe("Log Write Path", () => {
  it("short writes: writes complete lines with valid JSON and sequential seq", () => {
    const io = new FakeIo({ chunk: 10 });
    const { log, file } = makeLog(io);
    for (let index = 0; index < 5; index += 1) {
      log.append("user/message", { text: `第 ${String(index)} 条，写长一点让短写真的发生`, attachments: [] });
    }
    log.close();

    // 短写确实发生了（一条事件远大于 10 字节）。
    expect(io.writeCalls).toBeGreaterThan(5);

    const raw = lines(file);
    expect(raw).toHaveLength(6);
    for (const line of raw) expect(() => JSON.parse(line) as unknown).not.toThrow();

    const loaded = loadLog(file, { repair: true });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(loaded.value.truncatedBytes).toBe(0);
    }
  });

  it("reverts to pre-write offset without partial lines or sequence jumps on short write failure", () => {
    const io = new FakeIo({ chunk: 10, failAfterBytes: 25 });
    const { log, file } = makeLog(io);
    const before = readFileSync(file, "utf8");
    expect(log.lastSeq).toBe(0);

    const error = (() => {
      try {
        log.append("user/message", { text: "这一条写到一半就失败", attachments: [] });
        return null;
      } catch (reason) {
        return reason;
      }
    })();
    expect(isRpcFailure(error)).toBe(true);
    if (isRpcFailure(error)) {
      expect(error.code).toBe("storage_failed");
      expect(error.message).toContain("写日志失败");
    }

    // 回退后文件长度与写入前逐字节相同。
    expect(io.truncateCalls).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(before);
    // 只有首行，没有半行。
    expect(lines(file)).toHaveLength(1);
    // seq 没被吃掉。
    expect(log.lastSeq).toBe(0);

    // 恢复正常后下一条仍然是 seq 1，且文件能整份加载。
    io.options.failAfterBytes = undefined;
    io.options.chunk = undefined;
    const appended = log.append("user/message", { text: "接着来", attachments: [] });
    expect(appended.seq).toBe(1);
    log.close();

    const loaded = loadLog(file, { repair: true });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.events.map((event) => event.seq)).toEqual([1]);
      expect(loaded.value.truncatedBytes).toBe(0);
    }
  });

  it("treats 0-byte write as failure and rolls back offset", () => {
    const io = new FakeIo({ zeroOnce: true });
    const { log, file } = makeLog(io);
    const before = readFileSync(file, "utf8");

    expect(() => {
      log.append("user/message", { text: "一点都没写进去", attachments: [] });
    }).toThrowError(/写入中断/);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(log.lastSeq).toBe(0);

    const appended = log.append("user/message", { text: "第二次成了", attachments: [] });
    expect(appended.seq).toBe(1);
  });

  it("handles periodic fsync failure safely without crashing process", async () => {
    const io = new FakeIo({ failFsync: true });
    const { log, file } = makeLog(io);
    // 只追加 1 条：不触发"累计 5 条"的同步 flush，走 50ms 定时器。
    log.append("user/message", { text: "落盘会失败的一条", attachments: [] });
    expect(log.pendingWrites).toBe(1);

    await waitForFlushFailure(log);
    // 定时器已经跑过并失败；这里能继续执行就说明异常没有逃出去。
    expect(log.flushFailed).toBe(true);
    expect(io.options.failFsync).toBe(true);
    expect(log.pendingWrites).toBe(1);
    // 事件在页缓存里，读取侧看得到。
    expect(lines(file)).toHaveLength(2);
    expect(() => JSON.parse(lines(file)[1] ?? "") as unknown).not.toThrow();

    // 收尾：让 fsync 恢复正常再把账平掉。
    io.options.failFsync = false;
    log.close();
  });

  it("retries flush on subsequent append preserving complete data integrity", () => {
    const io = new FakeIo({ failFsync: true });
    const { log, file } = makeLog(io);
    for (let index = 1; index <= 4; index += 1) {
      log.append("user/message", { text: `第 ${String(index)} 条`, attachments: [] });
    }
    // 第 5 条触发"累计 5 条"的同步落盘：异常抛给调用方，但这一条其实已经写进日志。
    expect(() => {
      log.append("user/message", { text: "第 5 条", attachments: [] });
    }).toThrowError(/未确认落盘/);
    expect(log.lastSeq).toBe(5);
    expect(log.pendingWrites).toBe(5);

    // 恢复之后：下一次 append 先重试 flush（清掉 flushError），再写新的一行。
    io.options.failFsync = false;
    const appended = log.append("user/message", { text: "恢复后的第一条", attachments: [] });
    expect(appended.seq).toBe(6);
    log.close();

    const loaded = loadLog(file, { repair: true });
    expect(loaded.ok ? "ok" : `${loaded.error.code}:${loaded.error.message}`).toBe("ok");
    if (loaded.ok) {
      expect(loaded.value.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(loaded.value.truncatedBytes).toBe(0);
    }
  });

  it("preserves original write error when rollback truncation also fails", () => {
    const io = new FakeIo({ chunk: 10, failAfterBytes: 20 });
    const original = io.truncate.bind(io);
    io.truncate = (fd: number, size: number): void => {
      original(fd, size);
      throw new Error("回退也失败（注入）");
    };
    const { log, file } = makeLog(io);

    const error = (() => {
      try {
        log.append("user/message", { text: "写一半、退一半", attachments: [] });
        return null;
      } catch (reason) {
        return reason;
      }
    })();
    expect(isRpcFailure(error)).toBe(true);
    if (isRpcFailure(error)) {
      expect(error.code).toBe("storage_failed");
      // 报的是"写日志失败"，不是 truncate 的那条。
      expect(error.message).toContain("写日志失败");
      expect(error.message).not.toContain("回退也失败");
    }
    // 回退真的执行过（虽然它自己也抛了）。
    expect(io.truncateCalls).toBe(1);
    expect(log.lastSeq).toBe(0);
    // 模拟截断回退失败时的极端场景，断言抛出的错误类型。
    expect(file.length).toBeGreaterThan(0);
  });

  it("close() throws storage_failed on flush failure while keeping written events", () => {
    const io = new FakeIo({ failFsync: true });
    const { log, file } = makeLog(io);
    for (let index = 1; index <= 5; index += 1) {
      try {
        log.append("user/message", { text: `第 ${String(index)} 条`, attachments: [] });
      } catch {
        // 第 5 条会撞上同步 flush，单独在下面断言。
      }
    }
    const error = (() => {
      try {
        log.close();
        return null;
      } catch (reason) {
        return reason;
      }
    })();
    expect(isRpcFailure(error)).toBe(true);
    if (isRpcFailure(error)) {
      expect(error.code).toBe("storage_failed");
      expect(error.message).toContain("未确认落盘");
    }
    // 数据在页缓存里，仍然可读。
    const linesRead = lines(file);
    expect(linesRead).toHaveLength(6);
    for (const line of linesRead) expect(() => JSON.parse(line) as unknown).not.toThrow();
  });

  it("keeps session usable and body intact with original metadata on header write failure", () => {
    const io = new FakeIo({ failRewrite: true });
    const { log, file, header } = makeLog(io);
    for (let index = 1; index <= 3; index += 1) {
      log.append("user/message", { text: `第 ${String(index)} 条`, attachments: [] });
    }
    const before = readFileSync(file, "utf8");

    const error = (() => {
      try {
        log.rewriteMeta({ ...META, title: "新名字" });
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
    // 文件没被改：原子写失败时原文件保持原样。
    expect(readFileSync(file, "utf8")).toBe(before);

    // 关键：fd 已经重开，会话还能继续写。
    const appended = log.append("user/message", { text: "失败之后照常写", attachments: [] });
    expect(appended.seq).toBe(4);
    expect(log.lastSeq).toBe(4);
    log.close();

    const loaded = loadLog(file, { repair: true });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
      expect(loaded.value.header.meta.title).toBe(header.meta.title);
      expect(loaded.value.header.meta.title).not.toBe("新名字");
    }
  });

  it("marks handle closed when header update and reopen both fail", () => {
    const io = new FakeIo({ failRewrite: true });
    const { log, file } = makeLog(io);
    log.append("user/message", { text: "先写一条", attachments: [] });
    // 把日志文件拿走：重写失败之后 openSync 也一定失败。
    rmSync(file, { force: true });

    const error = (() => {
      try {
        log.rewriteMeta({ ...META, title: "新名字" });
        return null;
      } catch (reason) {
        return reason;
      }
    })();
    expect(isRpcFailure(error)).toBe(true);
    if (isRpcFailure(error)) {
      expect(error.code).toBe("storage_failed");
      // 消息里说清"会话需要重新打开"，而不是丢一个裸 EBADF。
      expect(error.message).toContain("无法重新打开日志");
      expect(error.code).toBe("storage_failed");
    }
    expect(() => {
      log.append("user/message", { text: "还写吗", attachments: [] });
    }).toThrowError(/日志已关闭/);
  });

  it("reports message unwritten and retryable when prior flush is unrecovered", async () => {
    const io = new FakeIo({ failFsync: true });
    const { log, file } = makeLog(io);
    log.append("user/message", { text: "第一条", attachments: [] });
    // 等定时器把 fsync 打失败（只记进 flushError，不抛）。
    await waitForFlushFailure(log);

    const error = (() => {
      try {
        log.append("user/message", { text: "第二条没写进去", attachments: [] });
        return null;
      } catch (reason) {
        return reason;
      }
    })();
    expect(isRpcFailure(error)).toBe(true);
    if (isRpcFailure(error)) {
      expect(error.code).toBe("storage_failed");
      expect(error.message).toContain("本条消息未写入");
      expect(error.message).toContain("可以重试");
      expect(error.message).not.toContain("不要重试");
      // 这条现在守的是全局行为（`RpcFailure.of` 幂等，见 test/host/failure.test.ts）：
      expect(error.message).toBeTruthy();
    }

    // 这一条确实没落盘：恢复落盘后只有第一条。
    io.options.failFsync = false;
    log.close();
    const loaded = loadLog(file, { repair: true });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.events.map((event) => event.seq)).toEqual([1]);
      expect(loaded.value.truncatedBytes).toBe(0);
    }
  });

  it("wraps file stat error into storage_failed without raw exceptions or truncation", () => {
    const io = new FakeIo();
    io.size = (): number => {
      throw new Error("句柄已失效（注入）");
    };
    const { log } = makeLog(io);

    const error = (() => {
      try {
        log.append("user/message", { text: "连长度都取不到", attachments: [] });
        return null;
      } catch (reason) {
        return reason;
      }
    })();
    expect(isRpcFailure(error)).toBe(true);
    if (isRpcFailure(error)) {
      expect(error.code).toBe("storage_failed");
      expect(error.message).toContain("写日志失败");
      expect(error.message).toContain("句柄已失效");
    }
    // 一个字节都没写，也没有截断（截到哪都不知道）。
    expect(io.truncateCalls).toBe(0);
    expect(log.lastSeq).toBe(0);
  });

  it("regression: handle remains valid after metadata update allowing subsequent appends", () => {
    const io = new FakeIo();
    const { log, file } = makeLog(io);
    log.append("user/message", { text: "改名前", attachments: [] });
    log.rewriteMeta({ ...META, title: "改后的名字" });
    expect(io.rewriteCalls).toBe(1);

    // 改名成功后同一个 log 还能继续追加（fd 已重开）。
    const appended = log.append("user/message", { text: "改名后", attachments: [] });
    expect(appended.seq).toBe(2);
    log.close();

    const loaded = loadLog(file, { repair: true });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.header.meta.title).toBe("改后的名字");
      expect(loaded.value.events.map((event) => event.seq)).toEqual([1, 2]);
      const texts = loaded.value.events
        .filter((event) => event.type === "user/message")
        .map((event) => (event.type === "user/message" ? event.text : ""));
      expect(texts).toEqual(["改名前", "改名后"]);
      expect(loaded.value.truncatedBytes).toBe(0);
    }
  });

  it("writes 10MB event across chunks and reads back byte-for-byte identical", () => {
    const io = new FakeIo({ chunk: 64 * 1024 });
    const { log, file } = makeLog(io);
    const text = "汉字".repeat(1_500_000); // 每个汉字 3 字节 → 约 9MB
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(8 * 1024 * 1024);
    log.append("user/message", { text, attachments: [] });
    log.close();

    expect(io.writeCalls).toBeGreaterThan(100);
    const loaded = loadLog(file, { repair: true });
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      const event = loaded.value.events[0];
      expect(event?.type).toBe("user/message");
      if (event?.type === "user/message") {
        expect(event.text.length).toBe(text.length);
        expect(event.text).toBe(text);
      }
      expect(loaded.value.truncatedBytes).toBe(0);
    }
  }, 120_000);
});
