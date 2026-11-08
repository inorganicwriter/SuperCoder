/**
 * 单个会话的句柄：日志 + 投影 + 订阅。遵循架构设计规范–。
 *
 * 一个会话只有一个写入方（C4）：`append` 从这里走，`seq` 也在这里分配。
 * 界面订阅拿到的是"新增事件"，补发由 `since(seq)` 提供。
 */

import type { EventType, LogHeader, SessionEvent, SessionMeta } from "../../shared/session/events.js";
import { SessionDerivation, type DerivedView, type SessionSummary } from "../../shared/session/derive.js";
import type { Capsule } from "../../shared/domain/capsule.js";
import { err, ok, type Result } from "../../shared/result.js";
import { fail, isRpcFailure, RpcFailure } from "../boot/failure.js";
import {
  buildIndex,
  deleteSessionIndex,
  readSessionIndex,
  writeSessionIndex,
  type SessionIndex,
} from "./index.js";
import { openLog, type EventInput, type LogIo, type SessionLog } from "./log.js";
import { ANCHOR_EVERY, type LoadError } from "./reader.js";

export interface SessionHandleDeps {
  readonly sessionId: string;
  readonly meta: SessionMeta;
  readonly workspaceId: string;
  readonly logFile: string;
  readonly indexPath: string;
  readonly repair?: boolean;
  /** 注入文件操作（测试用）。默认走 node:fs。 */
  readonly logIo?: LogIo;
}

export interface OpenedSession {
  readonly handle: SessionHandle;
  readonly repairedBytes: number;
}

export type EventListener = (events: readonly SessionEvent[]) => void;

export class SessionHandle {
  private readonly events: SessionEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private anchors: number[];
  private header: LogHeader;
  private derivation: SessionDerivation;
  private turn: { readonly turnId: string; readonly startedAt: string } | null = null;

  private constructor(
    readonly sessionId: string,
    workspaceId: string,
    private readonly log: SessionLog,
    private readonly logFile: string,
    private readonly indexPath: string,
    header: LogHeader,
    events: SessionEvent[],
    anchors: number[],
  ) {
    this.header = header;
    this.anchors = anchors;
    this.derivation = new SessionDerivation({ sessionId, workspaceId });
    for (const event of events) {
      this.events.push(event);
      this.derivation.apply(event);
    }
  }

  static open(deps: SessionHandleDeps): Result<OpenedSession, LoadError> {
    const opened = openLog(deps.logFile, deps.meta, {
      repair: deps.repair !== false,
      ...(deps.logIo === undefined ? {} : { io: deps.logIo }),
    });
    if (!opened.ok) return err(opened.error);
    const { log, header, events, truncatedBytes, anchors } = opened.value;
    // 工作区以首行为准：句柄是谁打开的、从哪个入口打开的，都不该改历史归属。
    const workspaceId = header.meta.workspace !== "" ? header.meta.workspace : deps.workspaceId;
    const handle = new SessionHandle(
      deps.sessionId,
      workspaceId,
      log,
      deps.logFile,
      deps.indexPath,
      header,
      events,
      anchors,
    );
    return ok({ handle, repairedBytes: truncatedBytes });
  }

  get meta(): SessionMeta {
    return this.header.meta;
  }

  get logHeader(): LogHeader {
    return this.header;
  }

  get lastSeq(): number {
    return this.log.lastSeq;
  }

  get isBusy(): boolean {
    return this.turn !== null;
  }

  get currentTurnId(): string | null {
    return this.turn?.turnId ?? null;
  }

  get currentTurnStartedAt(): string | null {
    return this.turn?.startedAt ?? null;
  }

  get logPath(): string {
    return this.logFile;
  }

  get indexFilePath(): string {
    return this.indexPath;
  }

  view(): DerivedView {
    return this.derivation.view();
  }

  summary(): SessionSummary {
    const view = this.view();
    const lastMessage = view.messages[view.messages.length - 1];
    return {
      sessionId: this.sessionId,
      title: this.header.meta.title,
      createdAt: this.header.meta.createdAt,
      updatedAt: lastMessage?.at ?? this.header.meta.createdAt,
      workspace: this.header.meta.workspace,
      language: this.header.meta.language,
      status: view.status,
      lastSeq: view.lastSeq,
      counts: view.counts,
    };
  }

  capsules(): Capsule[] {
    return [...this.view().capsules];
  }

  /** 订阅增量事件。返回退订函数。 */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 补发：`seq > sinceSeq` 的全部事件。 */
  since(sinceSeq: number): SessionEvent[] {
    if (sinceSeq <= 0) return [...this.events];
    const from = this.events.findIndex((event) => event.seq > sinceSeq);
    return from < 0 ? [] : this.events.slice(from);
  }

  allEvents(): readonly SessionEvent[] {
    return this.events;
  }

  anchorsSnapshot(): number[] {
    return [...this.anchors];
  }

  /**
   * 追加一条事件：分配 seq → 落盘 → 投影 → 通知订阅者。
   * 先落盘再投影：界面永远不会看到没有落盘的状态。
   */
  append<K extends EventType>(type: K, payload: EventInput<K>): SessionEvent {
    let event: SessionEvent;
    try {
      event = this.log.append(type, payload);
    } catch (error) {
      // 落盘确认失败（fsync）时这一行已经写进日志了：内存照常推进再抛出，
      // 否则磁盘有 seq N、内存没有，界面看不到这条消息，重启后它又冒出来。
      if (isRpcFailure(error) && error.writtenEvent !== undefined) {
        this.absorb(error.writtenEvent as SessionEvent);
      }
      throw error;
    }
    this.absorb(event);
    return event;
  }

  /** 投影一条已经确定进入日志的事件，并通知订阅者。 */
  private absorb(event: SessionEvent): void {
    this.events.push(event);
    const seq = event.seq;
    if (seq % ANCHOR_EVERY === 0) {
      this.anchors[Math.floor(seq / ANCHOR_EVERY) - 1] = seq + 1;
    }
    this.derivation.apply(event);
    for (const listener of this.listeners) listener([event]);
  }

  /**
   * 只在内存里推一条事件：`request/delta` 这类瞬态。
   *
   * 它不落盘、不占 seq（借下一次写入的序号），收到的一端只把它当流式增量。
   */
  publishTransient(event: SessionEvent): void {
    for (const listener of this.listeners) listener([event]);
  }

  beginTurn(turnId: string): void {
    if (this.turn !== null) {
      fail("busy", `本会话正在执行回合 ${this.turn.turnId}，等它结束后再发送`);
    }
    this.turn = { turnId, startedAt: new Date().toISOString() };
  }

  endTurn(): void {
    this.turn = null;
  }

  /** `turn/end` 之后整体重写索引。 */
  writeIndex(): void {
    const index = buildIndex({
      sessionId: this.sessionId,
      header: this.header,
      view: this.view(),
      anchors: this.anchors,
    });
    writeSessionIndex(this.indexPath, index);
  }

  readIndex(): SessionIndex | null {
    return readSessionIndex(this.indexPath, this.sessionId);
  }

  dropIndex(): void {
    deleteSessionIndex(this.indexPath);
  }

  /** 改名：只替换首行元数据，正文不动。 */
  rename(title: string): void {
    const next: SessionMeta = { ...this.header.meta, title };
    this.log.rewriteMeta(next);
    this.header = { ...this.header, meta: next };
    this.writeIndex();
  }

  close(): void {
    this.listeners.clear();
    this.log.close();
  }
}

/** 日志加载失败时映射为 RPC 错误并中断打开，避免在损坏数据上继续写入。 */
export function loadErrorToFailure(error: LoadError): RpcFailure {
  switch (error.code) {
    case "missing":
      return RpcFailure.of("not_found", error.message);
    case "shape_mismatch":
      return RpcFailure.of("shape_mismatch", `${error.message}。${error.hint}`);
    default:
      return RpcFailure.of(
        "storage_failed",
        `${error.message}${error.line === undefined ? "" : `（第 ${error.line} 行）`}。${error.hint}`,
      );
  }
}
