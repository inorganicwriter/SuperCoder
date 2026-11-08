/**
 * 实例锁的进程号复用：Windows 会把已退出进程的号很快分给别的进程。
 *
 * 实际遇到过：上一次的 SuperCoder 异常退出没删锁，锁里的号后来被 conhost.exe 占用，
 * 于是"这个号还活着"→ 误判已有实例在运行，应用再也起不来。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../../src/host/boot/lock.js";
import { resolveAppPaths } from "../../src/host/boot/paths.js";

function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "sc-lock-"));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("Instance Lock PID Reuse", () => {
  it("reclaims lock when PID is alive but process started after lock creation", () => {
    withHome((home) => {
      const paths = resolveAppPaths({ SUPERCODER_HOME: home });
      // 用当前进程的号（一定活着），但锁的时间写在很久以前。
      writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z", instanceId: "old" }));
      const outcome = acquireInstanceLock(paths, () => Date.now());
      expect(outcome.ok).toBe(true);
      expect(JSON.parse(readFileSync(join(home, "host.lock"), "utf8")).instanceId).not.toBe("old");
      if (outcome.ok) outcome.release();
    });
  });

  it("refuses start when locking process started before lock was created", () => {
    withHome((home) => {
      const paths = resolveAppPaths({ SUPERCODER_HOME: home });
      const lockedAt = new Date().toISOString();
      writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, startedAt: lockedAt, instanceId: "live" }));
      const outcome = acquireInstanceLock(paths, () => Date.parse(lockedAt) - 2_000);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toContain("SuperCoder 已经在运行");
        expect(outcome.reason).toContain("host.lock");
        expect(outcome.reason).not.toContain("审批");
      }
    });
  });

  it("fails safe treating process as running when start time cannot be read", () => {
    withHome((home) => {
      const paths = resolveAppPaths({ SUPERCODER_HOME: home });
      writeFileSync(join(home, "host.lock"), JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" }));
      expect(acquireInstanceLock(paths, () => null).ok).toBe(false);
    });
  });
});
