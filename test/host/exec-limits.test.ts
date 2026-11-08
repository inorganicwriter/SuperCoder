/**
 * 子进程输出的上限。遵循架构设计规范。
 *
 * `runProcess` 把 stdout/stderr 无上限地塞进数组。一个跑飞的命令
 * （`yes`、死循环打印、`git status` 遇到超大仓库）能在几十秒里吃掉几个 GB 内存，
 * 而这类命令常常还带超时之外的"输出刷屏"，超时兜不住。
 * 超过上限必须终止子进程，并在结果里明说"输出不完整" —— 不能把截断结果当完整结果返回。
 */

import { describe, expect, it } from "vitest";
import { runProcess } from "../../src/host/boot/exec.js";
import { makeTempHome } from "../helpers/temp.js";

describe("runProcess Output Limit Enforcement", () => {
  it("terminates child process and marks overflowed when output exceeds limit", async () => {
    const temp = makeTempHome();
    try {
      // 持续向 stdout 写入，直至被执行限制机制终止。
      // 每 5ms 写 64 KiB：很快就撞上 128 KiB 的上限。
      const script = "setInterval(() => { process.stdout.write('x'.repeat(65536)); }, 5);";
      const result = await runProcess(process.execPath, ["-e", script], {
        cwd: temp.home,
        timeoutMs: 10_000,
        maxOutputBytes: 128 * 1024,
      });
      expect(result.overflowed).toBe(true);
      // 只保留上限以内的内容，不是"收了多少算多少"。
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(128 * 1024);
      // 子进程被成组终止：要么退出码非 0，要么带着信号。
      expect(result.code !== 0 || result.signal !== null).toBe(true);
      // 这不是超时，也不是外部取消。
      expect(result.timedOut).toBe(false);
      expect(result.aborted).toBe(false);
    } finally {
      temp.cleanup();
    }
  }, 20_000);

  it("keeps overflowed false and retains full output when within limit", async () => {
    const temp = makeTempHome();
    try {
      const result = await runProcess(
        process.execPath,
        ["-e", "process.stdout.write('hello'); process.stderr.write('bye');"],
        { cwd: temp.home, timeoutMs: 10_000 },
      );
      expect(result.overflowed).toBe(false);
      expect(result.stdout).toBe("hello");
      expect(result.stderr).toBe("bye");
      expect(result.code).toBe(0);
    } finally {
      temp.cleanup();
    }
  }, 20_000);
});
