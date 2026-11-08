/**
 * 七项性能预算的一次性基准测量。
 *
 * `pnpm bench` 跑完全部七项并输出 JSON；每项都给出目标、实测、是否达标。
 * 默认静置 5 分钟；用 SUPERCODER_BENCH_IDLE_MS 可以缩短，
 * 缩短时结果里会标 `idle_ms`，不会被当成 5 分钟的结论。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { startHost, type RunningHost } from "../src/host/index.js";
import { silentLogger } from "../src/host/boot/logger.js";
import { createTestBackend } from "../src/host/boot/secrets.js";
import { SessionStore } from "../src/host/session/store.js";
import { snapshotWorkspace } from "../src/host/workspace/snapshot.js";
import { resolveAppPaths } from "../src/host/boot/paths.js";
import type { ServerFrame } from "../src/shared/protocol/rpc.js";
import type { SessionEvent } from "../src/shared/session/events.js";
import type { MethodName, MethodParams, MethodResult } from "../src/shared/protocol/methods.js";
import { ClientStore, type ClientTransport } from "../src/client/object/store.js";
import {
  budgetTarget,
  COLD_START_MS,
  IDLE_REQUESTS,
  INDEX_REBUILD_MS,
  LOG_P99_MS,
  SESSION_OPEN_MS,
  SNAPSHOT_MS,
  UI_DERIVATION_MS,
} from "./budgets.js";

const startedAt = performance.now();
const logger = silentLogger();

interface Measurement {
  readonly id: number;
  readonly name: string;
  readonly target: string;
  readonly actual: number;
  readonly unit: "ms" | "count";
  readonly pass: boolean;
  readonly note?: string;
}

const results: Measurement[] = [];

function record(measurement: Measurement): void {
  results.push(measurement);
  const verdict = measurement.pass ? "PASS" : "FAIL";
  process.stderr.write(
    `[${verdict}] #${measurement.id} ${measurement.name}: ${measurement.actual}${measurement.unit} (target: ${measurement.target})\n`,
  );
}

function makeScratch(name: string): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `supercoder-bench-${name}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 造一份 1 万条事件的会话，供第 3–5 项共用。 */
function seedBigSession(home: string): { sessionId: string; appends: number[] } {
  const paths = resolveAppPaths({ SUPERCODER_HOME: home });
  const store = new SessionStore({ paths, logger });
  const { sessionId } = store.create("bench", "性能样本");
  const handle = store.get(sessionId);
  const appends: number[] = [];
  handle.append("turn/start", { chatId: sessionId });
  for (let index = 0; index < 10_000; index += 1) {
    const before = performance.now();
    if (index % 2 === 0) {
      handle.append("user/message", { text: `第 ${index} 条问题`, attachments: [] });
    } else {
      handle.append("assistant/message", { step: index, text: `第 ${index} 条回答` });
    }
    appends.push(performance.now() - before);
  }
  handle.append("turn/end", { status: "completed" });
  store.closeAll();
  return { sessionId, appends };
}

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? 0;
}

async function firstFrame(host: RunningHost, sessionId: string): Promise<ServerFrame> {
  const origin = `http://127.0.0.1:${host.port}`;
  const socket = new WebSocket(`ws://127.0.0.1:${host.port}/ws?token=${host.token}`, {
    headers: { Origin: origin },
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });
  return await new Promise<ServerFrame>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("订阅超时")), 10_000);
    socket.on("message", (raw: unknown) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(raw)) as ServerFrame);
    });
    // 新会话没有历史事件，订阅本身不会有回包；再发一次 RPC 才算"能收能发"。
    socket.send(JSON.stringify({ kind: "subscribe", sessionId, sinceSeq: 0 }));
    socket.send(
      JSON.stringify({ kind: "rpc", rpcId: "bench-cold-start", method: "system.info", params: {} }),
    );
    socket.on("error", reject);
  });
}

/**
 * 第 7 项：界面派生。
 *
 * 直接走 `ClientStore` 的入站边（去重 → apply → view），跟真实推送同一条代码路径，
 * 不在 bench 里另写一份"看起来一样"的循环。
 */
class BenchTransport implements ClientTransport {
  currentStatus = "open" as const;
  subscribedSession: string | null = null;

  connect(): void {}
  close(): void {}

  subscribe(sessionId: string): void {
    this.subscribedSession = sessionId;
  }

  unsubscribe(): void {
    this.subscribedSession = null;
  }

  rpc<M extends MethodName>(method: M, _params: MethodParams<M>): Promise<MethodResult<M>> {
    const empty = (method === "task.list" || method === "capsule.list" ? [] : {}) as MethodResult<M>;
    return Promise.resolve(empty);
  }
}

function benchEvent(sessionId: string, seq: number, index: number): SessionEvent {
  const base = { seq, at: new Date(1_700_000_000_000 + seq).toISOString(), sessionId };
  if (index % 2 === 0) {
    return { ...base, type: "user/message", text: `第 ${String(index)} 条`, attachments: [] };
  }
  return { ...base, type: "assistant/message", step: 0, text: `第 ${String(index)} 条回答` };
}

async function measureUiDerivation(
  base: number,
  batches: number,
  batchSize: number,
): Promise<{ maxMs: number; p50Ms: number; batches: number; batchSize: number; messages: number }> {
  const sessionId = "00000000-0000-4000-8000-000000000000";
  const store = new ClientStore({ transport: new BenchTransport(), locale: "zh-CN" });
  await store.selectSession(sessionId);

  const seed: SessionEvent[] = [];
  for (let index = 0; index < base; index += 1) seed.push(benchEvent(sessionId, index + 1, index));
  store.applyEvents(sessionId, seed);

  const durations: number[] = [];
  let seq = base + 1;
  for (let batch = 0; batch < batches; batch += 1) {
    const events: SessionEvent[] = [];
    for (let offset = 0; offset < batchSize; offset += 1) {
      events.push(benchEvent(sessionId, seq, seq));
      seq += 1;
    }
    const before = performance.now();
    store.applyEvents(sessionId, events);
    durations.push(performance.now() - before);
  }

  return {
    maxMs: Math.max(...durations),
    p50Ms: percentile(durations, 0.5),
    batches,
    batchSize,
    messages: store.snapshot().view?.messages.length ?? 0,
  };
}

async function main(): Promise<void> {
  const scratch = makeScratch("main");
  const home = join(scratch.dir, "home");
  mkdirSync(home, { recursive: true });
  let host: RunningHost | null = null;

  try {
    // —— 1. 冷启动到可交互（headless 等价：进程启动 → 首帧订阅完成）——
    const coldStartBegin = startedAt;
    host = await startHost({
      home,
      port: 0,
      logger,
      skipInstanceLock: true,
      secretBackend: createTestBackend(),
      rendererDir: null,
    });
    const workspace = (await host.rpc("workspace.add", { path: home })) as {
      ok: true;
      result: { id: string };
    };
    const session = (await host.rpc("session.create", {
      workspaceId: workspace.result.id,
      title: "冷启动样本",
    })) as { ok: true; result: { sessionId: string } };
    const frame = await firstFrame(host, session.result.sessionId);
    const coldStartMs = performance.now() - coldStartBegin;
    record({
      id: 1,
      name: "冷启动到可交互",
      target: budgetTarget(COLD_START_MS, "ms"),
      actual: Math.round(coldStartMs),
      unit: "ms",
      pass: coldStartMs < COLD_START_MS,
      note: `首帧类型 ${frame.kind}（订阅 + 一次 RPC 往返）`,
    });

    // —— 2. 5000 文件快照 ——
    const filesDir = join(scratch.dir, "files");
    mkdirSync(filesDir, { recursive: true });
    for (let index = 0; index < 5000; index += 1) {
      const bucket = join(filesDir, `dir-${index % 50}`);
      if (index < 50) mkdirSync(bucket, { recursive: true });
      writeFileSync(join(bucket, `file-${index}.txt`), "x");
    }
    const snapshotBegin = performance.now();
    const snapshot = snapshotWorkspace(filesDir);
    const snapshotMs = performance.now() - snapshotBegin;
    record({
      id: 2,
      name: "5000 文件快照",
      target: budgetTarget(SNAPSHOT_MS, "ms"),
      actual: Math.round(snapshotMs),
      unit: "ms",
      pass: snapshotMs < SNAPSHOT_MS && snapshot.files.length === 5000,
      note: `文件数 ${snapshot.files.length}`,
    });

    // —— 3–5. 1 万条事件：写入 p99、打开、重建 ——
    const big = seedBigSession(home);
    const p99 = percentile(big.appends, 0.99);
    record({
      id: 3,
      name: "日志写入 p99",
      target: budgetTarget(LOG_P99_MS, "ms"),
      actual: Number(p99.toFixed(2)),
      unit: "ms",
      pass: p99 < LOG_P99_MS,
      note: `样本 ${big.appends.length} 次追加，p50=${percentile(big.appends, 0.5).toFixed(2)}ms`,
    });

    const paths = resolveAppPaths({ SUPERCODER_HOME: home });
    const openBegin = performance.now();
    const reopen = new SessionStore({ paths, logger });
    const handle = reopen.get(big.sessionId);
    const view = handle.view();
    const openMs = performance.now() - openBegin;
    reopen.closeAll();
    record({
      id: 4,
      name: "Session Open (10k Events)",
      target: budgetTarget(SESSION_OPEN_MS, "ms"),
      actual: Math.round(openMs),
      unit: "ms",
      pass: openMs < SESSION_OPEN_MS,
      note: `lastSeq=${view.lastSeq}`,
    });

    const rebuildBegin = performance.now();
    const rebuildStore = new SessionStore({ paths, logger });
    const summary = rebuildStore.rebuild(big.sessionId);
    const rebuildMs = performance.now() - rebuildBegin;
    rebuildStore.closeAll();
    record({
      id: 5,
      name: "索引重建（单会话 1 万条）",
      target: budgetTarget(INDEX_REBUILD_MS, "ms"),
      actual: Math.round(rebuildMs),
      unit: "ms",
      pass: rebuildMs < INDEX_REBUILD_MS,
      note: `重建后 lastSeq=${summary.lastSeq}`,
    });

    // —— 6. 空闲网络请求 ——
    const idleMs = Number(process.env["SUPERCODER_BENCH_IDLE_MS"] ?? "300000");
    const origin = `http://127.0.0.1:${host.port}`;
    const origin2 = `http://127.0.0.1:${host.port}`;
    void origin;
    const socket = new WebSocket(`ws://127.0.0.1:${host.port}/ws?token=${host.token}`, {
      headers: { Origin: origin2 },
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });
    let businessFrames = 0;
    socket.on("message", (raw: unknown) => {
      const parsed = JSON.parse(String(raw)) as ServerFrame;
      // 只数业务帧：心跳与订阅确认不算业务。
      if (parsed.kind === "events" || parsed.kind === "result") businessFrames += 1;
    });
    socket.send(JSON.stringify({ kind: "subscribe", sessionId: big.sessionId, sinceSeq: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    businessFrames = 0;
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    socket.close();
    record({
      id: 6,
      name: "空闲网络请求",
      target: budgetTarget(IDLE_REQUESTS, "count"),
      actual: businessFrames,
      unit: "count",
      pass: businessFrames <= IDLE_REQUESTS,
      note: `idle ${idleMs}ms`,
    });
    // —— 7. 界面派生：1 万条之后再单批新增 ——
    const ui = await measureUiDerivation(10_000, 200, 10);
    record({
      id: 7,
      name: "UI View Derivation (10k Base + Incremental)",
      target: budgetTarget(UI_DERIVATION_MS, "ms"),
      actual: Number(ui.maxMs.toFixed(2)),
      unit: "ms",
      pass: ui.maxMs < UI_DERIVATION_MS,
      note: `10k base + ${String(ui.batches)} batches × ${String(ui.batchSize)} items, p50=${ui.p50Ms.toFixed(2)}ms, view ${String(ui.messages)} items`,
    });
  } finally {
    if (host !== null) await host.close();
    scratch.cleanup();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    totalMs: Math.round(performance.now() - startedAt),
    passed: results.every((item) => item.pass),
    metrics: results,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

await main();
