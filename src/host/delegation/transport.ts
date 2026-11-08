/**
 * JSON-RPC over stdio。遵循架构设计规范。
 *
 * 三种接入方式（app-server、ACP、cli）共用这一个传输层：一行一个 JSON-RPC 2.0 帧。
 * 测试用 `FakeRpcTransport` 回放录制下来的 transcript，不需要真的装 codex。
 */

import type { ChildProcess } from "node:child_process";
import { messageOf } from "../boot/failure.js";
import { terminateProcessTree } from "../boot/exec.js";

export interface RpcNotification {
  readonly method: string;
  readonly params: unknown;
}

export type NotificationListener = (notification: RpcNotification) => void;
export type ExitListener = (info: { code: number | null; signal: NodeJS.Signals | null }) => void;

export interface JsonRpcTransport {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): void;
  onNotification(listener: NotificationListener): () => void;
  onExit(listener: ExitListener): () => void;
  close(): void;
}

export const DEFAULT_RPC_TIMEOUT_MS = 120_000;

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

export class TransportClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportClosedError";
  }
}

interface RpcMessage {
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/** 真实子进程的传输层。 */
export function createStdioTransport(child: ChildProcess, transportOptions: { readonly allowPermissions?: () => boolean } = {}): JsonRpcTransport {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, PendingRequest>();
  const notificationListeners = new Set<NotificationListener>();
  const exitListeners = new Set<ExitListener>();
  let buffer = "";

  const closeAll = (error: Error): void => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
      pending.delete(id);
    }
  };

  const handleMessage = (message: RpcMessage): void => {
    if (typeof message.method === "string") {
      // ACP permissions follow the per-agent policy; unsupported requests fail explicitly.
      if (message.id !== undefined) {
        if (message.method === "session/request_permission") {
          const params = typeof message.params === "object" && message.params !== null ? message.params as Record<string, unknown> : {};
          const options = Array.isArray(params["options"]) ? params["options"] : [];
          const allow = options.find((option: unknown) => typeof option === "object" && option !== null && (option as Record<string, unknown>)["kind"] === "allow_once") as Record<string, unknown> | undefined;
          const reject = options.find((option: unknown) => typeof option === "object" && option !== null && (option as Record<string, unknown>)["kind"] === "reject_once") as Record<string, unknown> | undefined;
          let permitted = false;
          try { permitted = transportOptions.allowPermissions?.() === true; } catch { /* Invalid preferences fail closed. */ }
          const selected = permitted ? allow : reject;
          const outcome = typeof selected?.["optionId"] === "string" ? { outcome: "selected", optionId: selected["optionId"] } : { outcome: "cancelled" };
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { outcome } })}\n`);
          for (const listener of notificationListeners) listener({ method: "supercoder/permission", params: { allowed: selected === allow && allow !== undefined } });
        } else if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
          let permitted = false;
          try { permitted = transportOptions.allowPermissions?.() === true; } catch { /* Invalid preferences fail closed. */ }
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { decision: permitted ? "accept" : "decline" } })}\n`);
          for (const listener of notificationListeners) listener({ method: "supercoder/permission", params: { allowed: permitted } });
        } else {
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client does not support this request" } })}\n`);
        }
        return;
      }
      for (const listener of notificationListeners) {
        listener({ method: message.method, params: message.params });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (request === undefined) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error !== undefined) {
      request.reject(new Error(`${request.method} 失败：${message.error.message ?? "对端报错"}`));
      return;
    }
    request.resolve(message.result);
  };

  const onData = (chunk: string): void => {
    buffer += chunk;
    let at = buffer.indexOf("\n");
    while (at >= 0) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line !== "") {
        try {
          handleMessage(JSON.parse(line) as RpcMessage);
        } catch {
          // 对端往 stdout 打了非 JSON 的调试输出：忽略，不影响协议帧。
        }
      }
      at = buffer.indexOf("\n");
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", onData);
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", () => {
    /* 诊断信息不参与协议；失败时靠 exit code 与通知判断 */
  });
  child.on("close", (code, signal) => {
    closed = true;
    const error = new TransportClosedError(`外部进程已退出（code=${String(code)}, signal=${String(signal)}）`);
    closeAll(error);
    for (const listener of exitListeners) listener({ code, signal });
  });
  child.on("error", (error) => {
    closed = true;
    closeAll(new TransportClosedError(`外部进程启动失败：${messageOf(error)}`));
  });

  return {
    request(method, params, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
      if (closed) return Promise.reject(new TransportClosedError("传输已关闭"));
      const id = nextId;
      nextId += 1;
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
        }, timeoutMs);
        timer.unref();
        pending.set(id, { method, resolve, reject, timer });
        child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method, params) {
      if (closed) return;
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    onNotification(listener) {
      notificationListeners.add(listener);
      return () => notificationListeners.delete(listener);
    },
    onExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },
    close() {
      closed = true;
      closeAll(new TransportClosedError("传输被主动关闭"));
      child.stdin?.end();
      terminateProcessTree(child);
    },
  };
}

/** 一步录制：对端应当收到的请求 → 我们给出的应答 / 之后主动推的通知。 */
export interface RecordedStep {
  readonly request?: string;
  readonly response?: unknown;
  readonly error?: { readonly message: string };
  readonly notifications?: readonly RpcNotification[];
}

/**
 * 回放传输层：把录好的 transcript 当成对端。
 * 多出来的请求一律报错，避免"少录了一步"却静默通过。
 */
export class FakeRpcTransport implements JsonRpcTransport {
  private cursor = 0;
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private closed = false;

  constructor(private readonly steps: readonly RecordedStep[]) {}

  get remaining(): number {
    return this.steps.length - this.cursor;
  }

  request(method: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new TransportClosedError("传输已关闭"));
    const step = this.steps[this.cursor];
    this.cursor += 1;
    if (step === undefined) {
      return Promise.reject(new Error(`回放脚本用完了，却收到请求 ${method}`));
    }
    if (step.request !== undefined && step.request !== method) {
      return Promise.reject(new Error(`回放脚本期望 ${step.request}，实际收到 ${method}`));
    }
    const notifications = step.notifications ?? [];
    if (notifications.length > 0) {
      // 通知在应答之后异步到达，更接近真实时序。
      setTimeout(() => {
        for (const notification of notifications) this.emit(notification);
      }, 0);
    }
    if (step.error !== undefined) return Promise.reject(new Error(step.error.message));
    return Promise.resolve(step.response);
  }

  notify(method: string): void {
    const step = this.steps[this.cursor];
    // 允许脚本把 notify 后面的通知挂在同一步里：`initialized` 之后常常紧跟首条日志。
    if (step !== undefined && step.notifications !== undefined && step.request === undefined) {
      for (const notification of step.notifications) this.emit(notification);
      this.cursor += 1;
      return;
    }
    void method;
  }

  /** 测试专用：在对端"推"一条通知（模拟执行过程中的进度）。 */
  push(notification: RpcNotification): void {
    this.emit(notification);
  }

  /** 测试专用：模拟进程退出。 */
  crash(code: number | null): void {
    this.closed = true;
    for (const listener of this.exitListeners) listener({ code, signal: null });
  }

  private emit(notification: RpcNotification): void {
    for (const listener of this.notificationListeners) listener(notification);
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
  }
}
