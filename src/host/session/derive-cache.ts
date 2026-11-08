/**
 * 派生结果的增量缓存。遵循架构设计规范（会话打开 / 索引重建的时间预算）。
 *
 * 缓存键是 (size, mtimeMs)：日志被别处追加过就重算，否则直接给上次的投影。
 * 它同样只是缓存——删掉不影响任何状态。
 */

import { statSync } from "node:fs";
import type { LogHeader, SessionEvent } from "../../shared/session/events.js";
import { SessionDerivation, type DeriveContext, type DerivedView } from "../../shared/session/derive.js";
import { loadLog } from "./reader.js";

interface CacheEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly header: LogHeader;
  readonly view: DerivedView;
  readonly anchors: readonly number[];
}

export interface CacheHit {
  readonly header: LogHeader;
  readonly view: DerivedView;
  readonly anchors: readonly number[];
  readonly fromCache: boolean;
}

export class DeriveCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly contextFor: (sessionId: string, header: LogHeader) => DeriveContext) {}

  invalidate(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** 日志变了就重算，没变就复用。日志不可读时返回 null。 */
  refresh(sessionId: string, logFile: string): CacheHit | null {
    let stat;
    try {
      stat = statSync(logFile);
    } catch {
      return null;
    }
    const cached = this.entries.get(sessionId);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { header: cached.header, view: cached.view, anchors: cached.anchors, fromCache: true };
    }
    const loaded = loadLog(logFile, { repair: false });
    if (!loaded.ok) return null;
    const context = this.contextFor(sessionId, loaded.value.header);
    const view = deriveAll(loaded.value.events, context);
    const entry: CacheEntry = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      header: loaded.value.header,
      view,
      anchors: loaded.value.anchors,
    };
    this.entries.set(sessionId, entry);
    return { header: entry.header, view: entry.view, anchors: entry.anchors, fromCache: false };
  }

  /** 已知日志内容时直接填缓存（会话已经打开的情况下避免二次读盘）。 */
  prime(
    sessionId: string,
    logFile: string,
    header: LogHeader,
    view: DerivedView,
    anchors: readonly number[],
  ): void {
    try {
      const stat = statSync(logFile);
      this.entries.set(sessionId, {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        header,
        view,
        anchors,
      });
    } catch {
      // 文件不在就没什么可缓存的。
    }
  }

  view(sessionId: string): DerivedView | null {
    return this.entries.get(sessionId)?.view ?? null;
  }
}

export function deriveAll(events: readonly SessionEvent[], context: DeriveContext): DerivedView {
  const derivation = new SessionDerivation(context);
  for (const event of events) derivation.apply(event);
  return derivation.view();
}
