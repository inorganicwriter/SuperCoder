/**
 * 事件订阅。遵循架构设计规范。
 *
 * 同一会话同一时刻只保持一个订阅：重复订阅时以最新的 `sinceSeq` 重新计算补发起点。
 * 补发每批 ≤ 200 条，之后转增量推送。
 */

import { EVENT_BATCH_LIMIT, type ServerFrame } from "../../shared/protocol/rpc.js";
import type { SessionEvent } from "../../shared/session/events.js";
import type { Logger } from "../boot/logger.js";

export interface Subscriber {
  readonly id: string;
  send(frame: ServerFrame): void;
}

export interface SubscriptionState {
  readonly sessionId: string;
  readonly sinceSeq: number;
  readonly subscriber: Subscriber;
}

export class SubscriptionHub {
  private readonly bySession = new Map<string, SubscriptionState>();
  /** 正在补发的会话：这期间到达的增量先攒着，等补发发完再按顺序推。 */
  private readonly backfilling = new Map<string, SessionEvent[]>();

  constructor(private readonly logger: Logger) {}

  /** 换订阅：最新的 sinceSeq 说了算。返回被替换掉的旧订阅。 */
  subscribe(sessionId: string, subscriber: Subscriber, sinceSeq: number): SubscriptionState | null {
    const previous = this.bySession.get(sessionId) ?? null;
    this.bySession.set(sessionId, { sessionId, sinceSeq, subscriber });
    if (previous && previous.subscriber.id !== subscriber.id) {
      this.logger.debug({ sessionId, dropped: previous.subscriber.id }, "会话订阅被新连接替换");
    }
    return previous;
  }

  /**
   * 开始补发：期间 `publish` 只入缓冲。
   * 不缓冲的话，客户端可能先收到新事件、再收到旧补发，按 seq 续接时会把旧事件丢掉。
   */
  beginBackfill(sessionId: string): void {
    this.backfilling.set(sessionId, []);
  }

  /** 结束补发：交出期间攒下的增量，由调用方在补发批次之后发送。 */
  endBackfill(sessionId: string): SessionEvent[] {
    const buffered = this.backfilling.get(sessionId) ?? [];
    this.backfilling.delete(sessionId);
    return buffered;
  }

  unsubscribe(sessionId: string, subscriberId?: string): void {
    const current = this.bySession.get(sessionId);
    if (!current) return;
    if (subscriberId !== undefined && current.subscriber.id !== subscriberId) return;
    this.bySession.delete(sessionId);
  }

  detachSubscriber(subscriberId: string): string[] {
    const dropped: string[] = [];
    for (const [sessionId, state] of this.bySession) {
      if (state.subscriber.id === subscriberId) {
        this.bySession.delete(sessionId);
        dropped.push(sessionId);
      }
    }
    return dropped;
  }

  count(): number {
    return this.bySession.size;
  }

  sessions(): string[] {
    return [...this.bySession.keys()];
  }

  /** 分批推送增量。订阅者已断开时静默丢弃（客户端会重新 subscribe 补发）。 */
  publish(sessionId: string, events: readonly SessionEvent[]): void {
    if (events.length === 0) return;
    const buffer = this.backfilling.get(sessionId);
    if (buffer !== undefined) {
      buffer.push(...events);
      return;
    }
    const state = this.bySession.get(sessionId);
    if (!state) return;
    for (let offset = 0; offset < events.length; offset += EVENT_BATCH_LIMIT) {
      const batch = events.slice(offset, offset + EVENT_BATCH_LIMIT);
      try {
        state.subscriber.send({ kind: "events", sessionId, events: [...batch] });
      } catch (error) {
        this.logger.warn({ sessionId, error: String(error) }, "推送事件失败，丢弃该订阅");
        this.bySession.delete(sessionId);
        return;
      }
    }
  }
}
