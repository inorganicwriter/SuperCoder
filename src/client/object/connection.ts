// i18n-exempt-file: 连接层诊断文案（随错误条与诊断包原样导出，不进文案表）
/**
 * 客户端通道。遵循架构设计规范。
 *
 * 客户端网络传输层：通过单一 WebSocket 连接复用 RPC 请求与服务端事件推送。
 * 收包一律先校验（C5）——服务端出错也不该把界面导致崩溃。
 */

import {
  ClientFrameSchema,
  ServerFrameSchema,
  type ClientFrame,
  type ServerFrame,
} from "../../shared/protocol/rpc.js";
import { METHODS, type MethodName, type MethodParams, type MethodResult } from "../../shared/protocol/methods.js";
import type { SessionEvent } from "../../shared/session/events.js";
import { isTransientEvent, parseSessionEvent } from "../../shared/session/events.js";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface ConnectionOptions {
  readonly port: number;
  readonly token: string;
  readonly onStatus: (status: ConnectionStatus, detail?: string) => void;
  readonly onEvents: (sessionId: string, events: readonly SessionEvent[]) => void;
  /** 重连退避的基数（毫秒）。默认 1000；测试里调小才有耐心等。 */
  readonly retryBaseMs?: number;
}

interface PendingRpc {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const RPC_TIMEOUT_MS = 120_000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15_000;

export class Connection {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "closed";
  private readonly pending = new Map<string, PendingRpc>();
  /** 订阅只记会话 id：补发起点由 `resumeSeq` 唯一表达，重连才能从"已收到的最后一条"续上。 */
  private subscription: { sessionId: string } | null = null;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  /**
   * 重连补发起点：**最后一条已落盘事件的序号**。
   *
   * 瞬态事件（`request/delta`）不推进它——它们借的是"下一条落盘事件的序号"，
   * 真把它当成已收到的进度，流式期间断线就会从 N+1 续订，那条 N+1 的正式消息再也收不到。
   */
  private resumeSeq = 0;

  constructor(private readonly options: ConnectionOptions) {}

  get currentStatus(): ConnectionStatus {
    return this.status;
  }

  /** 重连时用的补发起点（已落盘的最大 seq）。测试直接断言它，不用去解析帧。 */
  get resumeFrom(): number {
    return this.resumeSeq;
  }

  connect(): void {
    if (this.socket !== null) return;
    this.closedByUs = false;
    const url = `ws://127.0.0.1:${this.options.port}/ws?token=${encodeURIComponent(this.options.token)}`;
    this.setStatus("connecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      this.setStatus("closed", `无法建立连接：${String(error)}`);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.retry = 0;
      this.setStatus("open");
      if (this.subscription !== null) {
        // 补发起点必须是"已收到的最后一条"：写死成订阅时的快照会让服务端全量重放。
        this.send({
          kind: "subscribe",
          sessionId: this.subscription.sessionId,
          sinceSeq: this.resumeSeq,
        });
      }
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(String(event.data));
    });
    socket.addEventListener("close", () => {
      this.socket = null;
      this.failPending("连接已断开，正在尝试自动重连。");
      this.setStatus("closed");
      if (!this.closedByUs) this.scheduleRetry();
    });
    socket.addEventListener("error", () => {
      // close 事件随后到达，统一在那里处理。
    });
  }

  close(): void {
    this.closedByUs = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  /** 订阅（替换语义）：同一会话只保留一个订阅，`sinceSeq` 以最新一次为准。 */
  subscribe(sessionId: string, sinceSeq = 0): void {
    this.subscription = { sessionId };
    this.resumeSeq = sinceSeq;
    if (this.status === "open") {
      this.send({ kind: "subscribe", sessionId, sinceSeq });
    }
  }

  /** 取消订阅：契约里没有退订帧，本地清掉即可（旧会话的事件由上层按 id 过滤）。 */
  unsubscribe(): void {
    this.subscription = null;
  }

  get subscribedSession(): string | null {
    return this.subscription?.sessionId ?? null;
  }

  rpc<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    const parsed = METHODS[method].params.safeParse(params);
    if (!parsed.success) {
      return Promise.reject(new Error(`本机参数不符合契约：${method}`));
    }
    const rpcId = `c_${crypto.randomUUID()}`;
    return new Promise<MethodResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rpcId);
        reject(new Error(`${method} 超时（${Math.round(RPC_TIMEOUT_MS / 1000)} 秒没有回应）`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(rpcId, {
        resolve: (value) => resolve(value as MethodResult<M>),
        reject,
        timer,
      });
      this.send({ kind: "rpc", rpcId, method, params });
    });
  }

  private send(frame: ClientFrame): void {
    const parsed = ClientFrameSchema.safeParse(frame);
    if (!parsed.success) {
      this.options.onStatus(this.status, "内部错误：要发送的帧不符合契约");
      return;
    }
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      // 断开时快速失败未决请求，避免重连后重发非幂等的写操作。
      if (frame.kind === "rpc") {
        const pending = this.pending.get(frame.rpcId);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.pending.delete(frame.rpcId);
          pending.reject(new Error("连接尚未就绪，请等待连接建立后重试。"));
        }
      }
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }

  private handleMessage(raw: string): void {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      this.options.onStatus(this.status, "收到非 JSON 帧，已忽略");
      return;
    }
    const frame = ServerFrameSchema.safeParse(parsedJson);
    if (!frame.success) {
      this.options.onStatus(this.status, "收到不符合契约的帧，已忽略");
      return;
    }
    const value: ServerFrame = frame.data;
    if (value.kind === "result") {
      const pending = this.pending.get(value.rpcId);
      if (pending === undefined) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(value.rpcId);
      if (value.ok) pending.resolve(value.result);
      else pending.reject(new Error(value.error.message));
      return;
    }
    if (value.kind === "events") {
      const valid: SessionEvent[] = [];
      for (const event of value.events) {
        const checked = parseSessionEvent(event);
        if (checked.ok) valid.push(checked.value);
      }
      if (valid.length > 0) {
        // 逐个看，不能只取最后一条：一批里可能只有瞬态，也可能瞬态夹在中间，
        // 而瞬态借的 seq 比正式事件还"靠前"，按它推进就会跳过一条还没收到的落盘事件。
        for (const event of valid) {
          if (isTransientEvent(event.type)) continue;
          this.resumeSeq = Math.max(this.resumeSeq, event.seq);
        }
        this.options.onEvents(value.sessionId, valid);
      }
    }
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.status = status;
    this.options.onStatus(status, detail);
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    this.retry += 1;
    const base = this.options.retryBaseMs ?? RETRY_BASE_MS;
    const delay = Math.min(RETRY_MAX_MS, base * 2 ** Math.min(this.retry, 4));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pending.delete(id);
    }
  }
}
