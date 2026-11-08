/**
 * 起真进程的脚手架：崩溃用例与实例锁用例都要"杀一个真的 node"。
 * 遵循架构设计规范。
 *
 * 编译产物在 lib-scripts（`tsconfig.scripts.json` 的 include 里有这两个脚本）。
 * 缺了就同步补一次编译——**不允许跳过**，跳过等于没测。
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

function runTsc(args: readonly string[]): void {
  execFileSync(process.execPath, [TSC, ...args], { cwd: ROOT, stdio: "inherit" });
}

/** 编译 host 与脚本产物（幂等；已存在时只做存在性检查）。 */
export function ensureBuilt(): void {
  if (!existsSync(join(ROOT, "lib", "host", "index.js"))) runTsc(["-b", "tsconfig.host.json"]);
  if (!existsSync(join(ROOT, "lib-scripts", "test", "helpers", "crash-writer.js"))) {
    runTsc(["-p", "tsconfig.scripts.json"]);
  }
}

export function scriptPath(name: "crash-writer" | "host-runner"): string {
  return join(ROOT, "lib-scripts", "test", "helpers", `${name}.js`);
}

export interface ChildRun {
  readonly child: ChildProcess;
  /** 到目前为止 stdout 的所有行。 */
  lines(): string[];
  /** 等到 `predicate` 对累积的行返回 true。 */
  waitFor(predicate: (lines: readonly string[]) => boolean, timeoutMs?: number): Promise<void>;
  kill(): void;
  status(): { readonly exited: boolean; readonly code: number | null; readonly signal: string | null };
}

export function spawnNode(script: string, args: readonly string[]): ChildRun {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
  });
  const buffer: string[] = [];
  let rest = "";
  const collect = (chunk: unknown): void => {
    rest += String(chunk);
    const parts = rest.split("\n");
    rest = parts.pop() ?? "";
    for (const line of parts) buffer.push(line.trimEnd());
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const settled: { exited: boolean; code: number | null; signal: string | null } = {
    exited: false,
    code: null,
    signal: null,
  };
  child.on("exit", (code, signal) => {
    settled.exited = true;
    settled.code = code;
    settled.signal = signal;
  });

  return {
    child,
    lines: () => [...buffer],
    async waitFor(predicate, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(buffer)) return;
        if (settled.exited) throw new Error(`子进程提前退出：${buffer.slice(-8).join(" / ")}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`等待子进程输出超时：${buffer.slice(-8).join(" / ")}`);
    },
    kill() {
      if (!settled.exited) child.kill("SIGKILL");
    },
    status: () => ({ ...settled }),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
