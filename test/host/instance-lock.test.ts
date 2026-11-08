/**
 * 实例锁：同一份数据目录只能有一个 host 在写。遵循架构设计规范。
 *
 * 三种情形分别对应三种真实处境：
 * - 用户双击了两次图标 → 第二个必须明确失败
 * - 上次是崩溃退出（没机会删锁）→ 陈旧锁必须被接管，否则应用再也起不来
 * - host 被 SIGKILL → 锁文件留在原地，下一次启动必须照样能起
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { silentLogger } from "../../src/host/boot/logger.js";
import { startHost } from "../../src/host/index.js";
import { isRpcFailure } from "../../src/host/boot/failure.js";
import { makeTempHome } from "../helpers/temp.js";
import { ensureBuilt, scriptPath, sleep, spawnNode } from "../helpers/spawn-child.js";

const logger = silentLogger();

describe("Instance Lock", () => {
  it("prevents second instance in same home directory with actionable message", async () => {
    const home = makeTempHome();
    try {
      const first = await startHost({ home: home.home, port: 0, logger });
      try {
        const error = await startHost({ home: home.home, port: 0, logger }).then(
          () => null,
          (reason: unknown) => reason,
        );
        expect(error).not.toBeNull();
        expect(isRpcFailure(error)).toBe(true);
        if (isRpcFailure(error)) {
          expect(error.code).toBe("denied");
          expect(error.message).toContain("已经在运行");
          expect(error.message).not.toContain("审批");
          expect(error.message).toContain(String(process.pid));
          expect(error.message).toContain("SuperCoder 已经在运行");
        }
      } finally {
        await first.close();
      }
      // 关掉之后同一个 home 立刻能再起。
      const again = await startHost({ home: home.home, port: 0, logger });
      await again.close();
    } finally {
      home.cleanup();
    }
  });

  it("identifies dead PID in lock file as stale lock and reclaims it", async () => {
    const home = makeTempHome();
    try {
      writeFileSync(
        join(home.home, "host.lock"),
        JSON.stringify({ pid: 2_147_483_646, startedAt: "2026-01-01T00:00:00.000Z" }),
        "utf8",
      );
      const host = await startHost({ home: home.home, port: 0, logger });
      try {
        const lock = JSON.parse(readFileSync(join(home.home, "host.lock"), "utf8")) as {
          pid: number;
        };
        expect(lock.pid).toBe(process.pid);
      } finally {
        await host.close();
      }
    } finally {
      home.cleanup();
    }
  });

  it("heals and starts successfully when lock file contains corrupted JSON", async () => {
    const home = makeTempHome();
    try {
      writeFileSync(join(home.home, "host.lock"), '{"pid": 12', "utf8");
      const host = await startHost({ home: home.home, port: 0, logger });
      await host.close();
      expect(existsSync(join(home.home, "host.lock"))).toBe(false);
    } finally {
      home.cleanup();
    }
  });

  it("reclaims stale lock file after abnormal process crash", async () => {
    ensureBuilt();
    const home = makeTempHome();
    const run = spawnNode(scriptPath("host-runner"), [home.home]);
    try {
      await run.waitFor((lines) => lines.some((line) => line.startsWith("READY ")));
      const lockFile = join(home.home, "host.lock");
      const holder = JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number };
      expect(holder.pid).toBe(run.child.pid);
      expect(holder.pid).not.toBe(process.pid);

      run.kill();
      const deadline = Date.now() + 10_000;
      while (!run.status().exited && Date.now() < deadline) await sleep(20);
      expect(run.status().exited).toBe(true);

      // 锁文件还在（进程没机会跑清理），但 PID 已经不存在了。
      expect(existsSync(lockFile)).toBe(true);
      const host = await startHost({ home: home.home, port: 0, logger });
      try {
        const taken = JSON.parse(readFileSync(lockFile, "utf8")) as { pid: number };
        expect(taken.pid).toBe(process.pid);
      } finally {
        await host.close();
      }
    } finally {
      run.kill();
      home.cleanup();
    }
  }, 60_000);
});
