/**
 * 异常终止恢复测试：在进程写日志期间发送 SIGKILL 并在重启后加载日志。
 * 遵循架构设计规范。
 *
 * 和 `storage.test.ts` 的区别：那边是"在测试进程里手工构造一个坏状态"，
 * 这里是"让坏状态自己发生"——fd 未刷、header 重写一半、tmp 残留、实例锁残留，
 * 只有 SIGKILL 才撞得出来。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/host/boot/logger.js";
import { sessionIndexFile, sessionLogFile } from "../../src/host/boot/paths.js";
import { SessionStore } from "../../src/host/session/store.js";
import type { SessionEvent } from "../../src/shared/session/events.js";
import { makeTempHome } from "../helpers/temp.js";
import { ensureBuilt, scriptPath, sleep, spawnNode } from "../helpers/spawn-child.js";

const logger = silentLogger();

interface Observation {
  readonly round: number;
  readonly delayMs: number;
  readonly renameEvery: number;
  readonly printed: number;
  readonly persisted: number;
  readonly lastSeq: number;
  readonly repairedEvents: number;
  readonly torn: boolean;
}

function parseLines(file: string): { raw: string[]; bad: number[] } {
  const text = readFileSync(file, "utf8");
  const raw = text.split("\n");
  // 末尾的 \n 会产生一个空串：丢掉，剩下的每一行都必须能解析。
  if (raw[raw.length - 1] === "") raw.pop();
  const bad: number[] = [];
  raw.forEach((line, index) => {
    if (index === 0) return; // 首行是 header
    try {
      JSON.parse(line) as unknown;
    } catch {
      bad.push(index + 1);
    }
  });
  return { raw, bad };
}

function assertContiguous(events: readonly SessionEvent[]): void {
  const seqs = events.map((event) => event.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1));
}

describe("Crash Recovery (SIGKILL)", () => {
  it(
    "recovers cleanly from termination at random write points with monotonic seq and truncated corruption",
    async () => {
      ensureBuilt();
      const observations: Observation[] = [];

      for (let round = 0; round < 5; round += 1) {
        const home = makeTempHome();
        let run: ReturnType<typeof spawnNode> | null = null;
        const delayMs = 50 + Math.floor(Math.random() * 350);
        // 一半的轮次每 3 条重写一次首行元数据，让 SIGKILL 有机会落在 tmp + rename 中间。
        const renameEvery = round % 2 === 0 ? 0 : 3;
        try {
          run = spawnNode(scriptPath("crash-writer"), [
            home.home,
            ...(renameEvery > 0 ? ["--rename-every", String(renameEvery)] : []),
          ]);
          await run.waitFor((lines) => lines.filter((l) => l.startsWith("APPENDED")).length >= 50);
          await sleep(delayMs);
          const printed = run.lines().filter((line) => line.startsWith("APPENDED")).length;
          const sessionLine = run.lines().find((line) => line.startsWith("SESSION "));
          expect(sessionLine).toBeDefined();
          const sessionId = String(sessionLine).slice("SESSION ".length);
          run.kill();
          await sleep(60);

          // 1. store 加载时捕获并恢复损坏数据，不抛出未处理异常。
          const store = new SessionStore({ paths: home.paths, logger });
          const handle = store.get(sessionId);
          const firstLastSeq = handle.lastSeq;
          const events = handle.allEvents();
          const logFile = sessionLogFile(home.paths, sessionId);

          // 2. 已落盘的 seq 连续、无重复。
          assertContiguous(events);

          // 3. 纯文件层面：每一行都能解析（末行若被截断会先被修掉）。
          const parsed = parseLines(logFile);
          expect(parsed.bad).toEqual([]);
          expect(parsed.raw.length).toBe(events.length + 1);

          // 4. 末行要么完整，要么被截掉且只记一条 session/repaired（在末尾）。
          const repairedEvents = events.filter((event) => event.type === "session/repaired");
          expect(repairedEvents.length).toBeLessThanOrEqual(1);
          if (repairedEvents.length === 1) {
            expect(events[events.length - 1]?.type).toBe("session/repaired");
          }

          const dataEvents = events.filter((event) => event.type !== "session/repaired");
          // 只断言单向关系：看到过 APPENDED N，日志里就至少有 N 条。
          // 反向不成立——stdout 是管道，被 SIGKILL 时管道里攒着的行会一起丢，
          // 于是"落盘比打印多"是正常现象（多出来的就是还没打印的那几条）。
          expect(dataEvents.length).toBeGreaterThanOrEqual(printed);

          // 5. lastSeq 与最后一条事件对得上。
          expect(handle.lastSeq).toBe(events[events.length - 1]?.seq ?? 0);

          observations.push({
            round,
            delayMs,
            renameEvery,
            printed,
            persisted: dataEvents.length,
            lastSeq: handle.lastSeq,
            repairedEvents: repairedEvents.length,
            torn: repairedEvents.length === 1,
          });

          handle.close();

          // 6. index.json 不存在时也能打开（走重建）。
          rmSync(sessionIndexFile(home.paths, sessionId), { force: true });
          const reopened = new SessionStore({ paths: home.paths, logger });
          const again = reopened.get(sessionId);
          expect(again.lastSeq).toBe(handle.lastSeq);
          expect(again.allEvents().length).toBe(events.length);
          again.close();
          // 索引重建发生在"没打开过这个会话"的读取路径上：换一个只读摘要的 store。
          const fresh = new SessionStore({ paths: home.paths, logger });
          const summary = fresh.summaryOf(sessionId);
          expect(summary?.lastSeq).toBe(firstLastSeq);
          expect(existsSync(sessionIndexFile(home.paths, sessionId))).toBe(true);
        } finally {
          run?.kill();
          home.cleanup();
        }
      }

      // 5 次都得跑完；把观测打进日志方便事后看（失败时测试框架会保留输出）。
      expect(observations).toHaveLength(5);
      
    },
    120_000,
  );

  it(
    "initializes empty log with header when process is killed before first event",
    async () => {
      ensureBuilt();
      const home = makeTempHome();
      let run: ReturnType<typeof spawnNode> | null = null;
      try {
        run = spawnNode(scriptPath("crash-writer"), [home.home, "--idle"]);
        await run.waitFor((lines) => lines.some((line) => line.startsWith("SESSION ")));
        const sessionId = String(run.lines().find((line) => line.startsWith("SESSION "))).slice(8);
        run.kill();
        await sleep(60);

        const store = new SessionStore({ paths: home.paths, logger });
        const handle = store.get(sessionId);
        // 首行之后一条事件都没有：这是合法状态，不是截断。
        expect(handle.allEvents()).toEqual([]);
        expect(handle.lastSeq).toBe(0);
        const appended = handle.append("user/message", { text: "接着来", attachments: [] });
        expect(appended.seq).toBe(1);
        handle.close();
      } finally {
        run?.kill();
        home.cleanup();
      }
    },
    60_000,
  );

  it(
    "repeated recovery of corrupted log is idempotent and emits no duplicate repair events",
    async () => {
      ensureBuilt();
      const home = makeTempHome();
      let run: ReturnType<typeof spawnNode> | null = null;
      try {
        run = spawnNode(scriptPath("crash-writer"), [home.home]);
        await run.waitFor((lines) => lines.filter((l) => l.startsWith("APPENDED")).length >= 50);
        const sessionId = String(run.lines().find((line) => line.startsWith("SESSION "))).slice(8);
        run.kill();
        await sleep(60);

        // 截断日志末尾数据，模拟写入中途异常中断，验证修复分支。
        const logFile = sessionLogFile(home.paths, sessionId);
        const text = readFileSync(logFile, "utf8");
        writeFileSync(logFile, text.slice(0, text.length - 12), "utf8");

        const first = new SessionStore({ paths: home.paths, logger });
        const openedFirst = first.get(sessionId);
        const firstSeq = openedFirst.lastSeq;
        const firstEvents = openedFirst.allEvents().length;
        const repaired = openedFirst.allEvents().filter((e) => e.type === "session/repaired").length;
        expect(repaired).toBe(1);
        openedFirst.close();

        const second = new SessionStore({ paths: home.paths, logger });
        const openedSecond = second.get(sessionId);
        expect(openedSecond.lastSeq).toBe(firstSeq);
        expect(openedSecond.allEvents().length).toBe(firstEvents);
        expect(
          openedSecond.allEvents().filter((e) => e.type === "session/repaired").length,
        ).toBe(1);
        openedSecond.close();
      } finally {
        run?.kill();
        home.cleanup();
      }
    },
    60_000,
  );
});
