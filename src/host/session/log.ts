/**
 * 日志写入。遵循架构设计规范。
 *
 * 三件必须由这一处独揽的事：
 * - `seq` 单点分配：从 1 开始，只增不减；崩溃修复后从最后一条完整事件的 seq + 1 继续
 * - 追加写：`JSON.stringify` + `\n`，一次 write
 * - fsync 节流：距上次满 50ms 或累计 5 条事件，先到者为准
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  LOG_HEADER_KIND,
  type EventPayload,
  type EventType,
  type LogHeader,
  type SessionEvent,
  type SessionMeta,
} from "../../shared/session/events.js";
import { headerFields } from "../../shared/session/shape.js";
import { ensureDir, writeFileAtomic } from "../boot/atomic.js";
import { messageOf, RpcFailure } from "../boot/failure.js";
import { loadLog, type LoadError } from "./reader.js";

export const FSYNC_INTERVAL_MS = 50;
export const FSYNC_EVENT_COUNT = 5;

/**
 * 日志真正用到的文件操作。抽成接口只为一件事：让"短写、写失败、fsync 失败"可注入测试。
 *
 * 带位置与长度是必须的：一次 `write` 可能只写进去一部分（磁盘配额、网络盘超时、
 * 单条 10MB 事件的缓冲），必须能接着上次的位置续写，也必须能在失败后把文件截回原长。
 * 生产路径永远用下面的默认实现，行为和直接用 node:fs 完全一致。
 */
export interface LogIo {
  /** 当前文件长度（字节）。 */
  size(fd: number): number;
  /** 从 `position` 开始写 `buf[offset, offset+length)`，返回实际写入字节数。 */
  write(fd: number, buf: Buffer, offset: number, length: number, position: number): number;
  /** 把文件截到 `size` 字节。 */
  truncate(fd: number, size: number): void;
  /** 整份重写（tmp + rename 的原子写）：改首行元数据用。 */
  rewrite(file: string, content: string): void;
  fsync(fd: number): void;
  close(fd: number): void;
}

const nodeFsIo: LogIo = {
  size: (fd) => fstatSync(fd).size,
  write: (fd, buf, offset, length, position) => writeSync(fd, buf, offset, length, position),
  truncate: (fd, size) => {
    ftruncateSync(fd, size);
  },
  rewrite: (file, content) => {
    writeFileAtomic(file, content);
  },
  fsync: (fd) => {
    fsyncSync(fd);
  },
  close: (fd) => {
    closeSync(fd);
  },
};

export type EventInput<K extends EventType> = Omit<EventPayload<K>, "seq" | "at">;

export class SessionLog {
  private closed = false;
  private pending = 0;
  private lastFsyncAt = Date.now();
  private timer: NodeJS.Timeout | null = null;
  /**
   * 上一次落盘失败留下的账。
   *
   * 定时器里的 fsync 没人接异常，一次短暂的失败（杀毒软件占着文件、可移动盘掉线）
   * 会触发 uncaughtException 导致宿主进程退出。因此定时器错误记录在此，
   * 由下一次 `append` 决定是重试还是把它抛给调用方。
   */
  private flushError: RpcFailure | null = null;

  constructor(
    private fd: number,
    private readonly file: string,
    private nextSeqValue: number,
    private readonly io: LogIo = nodeFsIo,
  ) {}

  get filePath(): string {
    return this.file;
  }

  get lastSeq(): number {
    return this.nextSeqValue - 1;
  }

  get pendingWrites(): number {
    return this.pending;
  }

  /** 上一次落盘是否还没恢复（定时器里失败过、还没被重试成功）。 */
  get flushFailed(): boolean {
    return this.flushError !== null;
  }

  /**
   * 分配 seq、落一行、按节流规则决定是否立刻 fsync。
   *
   * 写失败时**不占用这个 seq**：跳号会让下一次加载把它当成"seq 不连续"而拒绝整份日志，
   * 于是"一块盘写不进去"会升级成"这个会话再也打不开"。
   */
  append<K extends EventType>(type: K, payload: EventInput<K>): SessionEvent {
    if (this.closed) throw new Error("日志已关闭，不能再追加");
    // 上一轮落盘失败还没解决：先重试一次。仍然失败的话，**这一条其实没写进去**，
    // 所以文案必须是"可以重试"——与 flush 失败时那条"不要重试"正好相反，两句不能共用。
    if (this.flushError !== null) {
      try {
        this.flush();
      } catch {
        // 直接提供详细错误信息。
        throw RpcFailure.of(
          "storage_failed",
          "上一次落盘未恢复，本条消息未写入，可以重试。仍失败请检查存储目录写入权限与磁盘空间。",
        );
      }
    }
    if (this.pending === 0) this.lastFsyncAt = Date.now();
    const seq = this.nextSeqValue;
    const event = { type, seq, at: new Date().toISOString(), ...payload } as unknown as SessionEvent;
    this.writeLine(`${JSON.stringify(event)}\n`);
    this.nextSeqValue += 1;
    this.pending += 1;
    try {
      this.scheduleFsync();
    } catch (error) {
      // 这一行已经进日志了，失败的只是 fsync 确认：把事件带出去，
      // 让会话内存照常推进（否则界面与磁盘从此分叉）。
      if (error instanceof RpcFailure) throw error.carrying(event);
      throw error;
    }
    return event;
  }

  /**
   * 落一整行，写完为止。
   *
   * 写入底层处理的关键边界情况：
   * - `writeSync` 可能**短写**，返回值是实际字节数，必须续写
   * - 写的位置由自己算，不用 fd 的隐式位置：截断之后隐式位置可能还在原处，
   *   接着写会在文件里留下零字节空洞
   * - 中途失败要把文件截回写入前，否则半行会夹在中间，下次加载判"第 N 行不是合法 JSON"，
   *   整份日志就永久打不开了（fd 因此用 `r+` 打开：O_APPEND 的句柄在 Windows 上
   *   `ftruncate` 直接 EPERM，回退会变成空操作）
   */
  private writeLine(line: string): void {
    const buffer = Buffer.from(line, "utf8");
    // 取不到文件长度时还一个字节都没写，不能去截断（截到哪都不知道）。
    let start: number | null = null;
    try {
      start = this.io.size(this.fd);
      let written = 0;
      while (written < buffer.length) {
        const rest = buffer.length - written;
        const count = this.io.write(this.fd, buffer, written, rest, start + written);
        if (count <= 0) throw new Error(`写入中断（已写 ${String(written)} / ${String(buffer.length)} 字节）`);
        written += count;
      }
    } catch (error) {
      // 回退失败就吞掉：原始错误更重要，而且这时文件已经坏了，再抛也救不回来。
      if (start !== null) {
        try {
          this.io.truncate(this.fd, start);
        } catch {
          // 见上
        }
      }
      throw RpcFailure.of("storage_failed", `写日志失败：${messageOf(error)}`);
    }
  }

  private scheduleFsync(): void {
    if (this.pending >= FSYNC_EVENT_COUNT) {
      this.flush();
      return;
    }
    const elapsed = Date.now() - this.lastFsyncAt;
    if (elapsed >= FSYNC_INTERVAL_MS) {
      this.flush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // 定时器回调里没有任何人接异常：这里必须自己吞掉，只记账。
      try {
        this.flush();
      } catch {
        // flush 已经把失败记进 flushError，交给下一次 append 处理。
      }
    }, Math.max(1, FSYNC_INTERVAL_MS - elapsed));
    this.timer.unref();
  }

  /** 立即落盘。节流窗口结束时由定时器调用，`close()` 也会调用。 */
  flush(): void {
    if (this.closed || this.pending === 0) return;
    try {
      this.io.fsync(this.fd);
    } catch (error) {
      // 事件其实已经进了页缓存：告诉调用方"不要重试"，重试只会多出一条消息。
      // 直接提供详细错误信息。
      const failure = RpcFailure.of(
        "storage_failed",
        `数据已写入日志但未确认落盘（${messageOf(error)}），重启后将以日志记录为准。`,
      );
      this.flushError = failure;
      throw failure;
    }
    this.flushError = null;
    this.pending = 0;
    this.lastFsyncAt = Date.now();
  }

  /**
   * 改写首行元数据（`session.rename`、语言切换）。
   *
   * 日志正文仍然只追加；只有首行被替换，走 tmp + rename 的原子写。
   * Windows 上不能 rename 一个还开着的文件，所以先关 fd 再重开。
   */
  rewriteMeta(meta: SessionMeta): void {
    if (this.closed) throw new Error("日志已关闭，不能改元数据");
    // flush 失败时 fd 还开着，直接抛即可，不要在这里重开。
    this.flush();
    this.io.close(this.fd);
    try {
      const header: LogHeader = { kind: LOG_HEADER_KIND, fields: headerFields(), meta };
      const body = existsSync(this.file) ? readBodyAfterHeader(this.file) : "";
      this.io.rewrite(this.file, `${JSON.stringify(header)}\n${body}`);
    } catch (error) {
      // 首行没改成，但会话还得能用：先把句柄重开，再把失败报上去。
      this.reopen("改元数据失败", error);
      throw RpcFailure.of("storage_failed", `改元数据失败：${messageOf(error)}`);
    }
    this.reopen("改元数据后重新打开日志失败");
  }

  /**
   * 重新拿到一个可用的句柄。
   *
   * 文件描述符已失效时：若 closed 状态未同步为 true，后续每次操作调用 io.size/io.write
   * 抛裸 EBADF，上层连错误码都拿不到，这个会话等于废掉。所以要么拿到新句柄，
   * 要么把会话明确标成已关闭，让人知道需要重新打开。
   */
  private reopen(reason: string, cause?: unknown): void {
    try {
      this.fd = openSync(this.file, "r+");
    } catch (error) {
      this.closed = true;
      const why = cause === undefined ? "" : `${messageOf(cause)}，且`;
      throw RpcFailure.of(
        "storage_failed",
        `${reason}（${why}无法重新打开日志：${messageOf(error)}）`,
      );
    }
  }

  close(): void {
    if (this.closed) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.flush();
    } finally {
      this.closed = true;
      this.io.close(this.fd);
    }
  }
}

function readBodyAfterHeader(file: string): string {
  // 只在这里做一次全量读取：改名是低频操作，代价可接受。
  const raw = readFileSync(file, "utf8");
  const at = raw.indexOf("\n");
  return at < 0 ? "" : raw.slice(at + 1);
}

export interface OpenedLog {
  readonly log: SessionLog;
  readonly header: LogHeader;
  readonly events: SessionEvent[];
  readonly truncatedBytes: number;
  readonly anchors: number[];
}

export type LogOpenResult =
  | { readonly ok: true; readonly value: OpenedLog }
  | { readonly ok: false; readonly error: LoadError };

export interface OpenLogOptions {
  /** 启动路径为 true：截断半行并追加 `session/repaired`。 */
  readonly repair?: boolean;
  /** 注入文件操作（测试用）。默认走 node:fs。 */
  readonly io?: LogIo;
}

/**
 * 打开（或新建）一个会话日志。
 *
 * 新建时首行是头部；已存在时先走  的三步，再接管追加。
 */
export function openLog(file: string, meta: SessionMeta, options: OpenLogOptions = {}): LogOpenResult {
  ensureDir(dirname(file));
  const repair = options.repair !== false;
  const io = options.io ?? nodeFsIo;
  const header: LogHeader = { kind: LOG_HEADER_KIND, fields: headerFields(), meta };

  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(header)}\n`, "utf8");
    const fd = openSync(file, "r+");
    return {
      ok: true,
      value: { log: new SessionLog(fd, file, 1, io), header, events: [], truncatedBytes: 0, anchors: [] },
    };
  }

  const loaded = loadLog(file, { repair });
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const log = new SessionLog(openSync(file, "r+"), file, loaded.value.events.length + 1, io);
  const events = loaded.value.events;
  let truncatedBytes = loaded.value.truncatedBytes;
  if (truncatedBytes > 0 && repair) {
    // 第 3 步：把这次修复本身也记进日志。
    const repaired = log.append("session/repaired", { truncatedBytes });
    log.flush();
    events.push(repaired);
    truncatedBytes = 0;
  }

  return {
    ok: true,
    value: {
      log,
      header: loaded.value.header,
      events,
      truncatedBytes,
      anchors: loaded.value.anchors,
    },
  };
}
