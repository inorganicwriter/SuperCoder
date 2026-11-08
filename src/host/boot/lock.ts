/**
 * 单实例锁。遵循架构设计规范（数据目录）、 P2（Electron 单实例锁）。
 *
 * 两层：应用级锁文件（一个数据目录一个实例），外加 Electron 的 requestSingleInstanceLock。
 * 这里的锁文件负责"同一份数据目录不能被两个 host 同时写"。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./atomic.js";
import { processStartedAt } from "./exec.js";
import type { AppPaths } from "./paths.js";

export interface LockInfo {
  readonly pid: number;
  readonly startedAt: string;
  /** 这一次获取锁的身份。同一个进程里起两个 host 也靠它区分。 */
  readonly instanceId?: string;
}

export type LockOutcome =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: string; readonly holder: LockInfo | null };

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM 说明进程存在但不属于我们：仍然算活着，别抢锁。
    return code === "EPERM";
  }
}

/**
 * 持锁进程是否还在。只看"这个进程号活着"不够：Windows 会复用已退出进程的号，
 * 锁里的号可能已经属于一个无关进程（实际遇到过被 conhost.exe 占用）。
 * 锁是进程启动之后才写的，真正的持有者一定比锁更早启动；比锁晚启动的就是复用。
 */
function holderRunning(holder: LockInfo, startedAt: (pid: number) => number | null): boolean {
  if (!processAlive(holder.pid)) return false;
  const lockedAt = Date.parse(holder.startedAt);
  const started = startedAt(holder.pid);
  if (started === null || Number.isNaN(lockedAt)) return true;
  // 留 5 秒余量：进程启动到写锁之间有加载时间，时钟精度也不同。
  return started <= lockedAt + 5_000;
}

export function acquireInstanceLock(paths: AppPaths, startedAt: (pid: number) => number | null = processStartedAt): LockOutcome {
  ensureDir(paths.home);
  const file = join(paths.home, "host.lock");
  if (existsSync(file)) {
    let holder: LockInfo | null = null;
    try {
      holder = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
    } catch {
      holder = null;
    }
    // 判据是"持锁的那个进程还活着"，不掺"是不是我自己"：
    // 同一个进程里起两个 host 也会各自打开同一份日志，同样会写坏。
    if (holder !== null && holderRunning(holder, startedAt)) {
      return {
        ok: false,
        reason: `SuperCoder 已经在运行（PID ${holder.pid}，启动于 ${holder.startedAt}）。请切换至已有窗口，或在确认未运行时删除 ${file} 后重试。`,
        holder,
      };
    }
    // 陈旧锁：持锁进程已不在（或进程号已被别的程序复用），直接接管。
    rmSync(file, { force: true });
  }
  const info: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    instanceId: randomUUID(),
  };
  writeFileSync(file, JSON.stringify(info), "utf8");
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
        // 只删自己的锁：别人接管之后再退出，不能顺手把新的锁删掉。
        const mine = current.instanceId === undefined ? current.pid === info.pid : current.instanceId === info.instanceId;
        if (mine) rmSync(file, { force: true });
      } catch {
        rmSync(file, { force: true });
      }
    },
  };
}
