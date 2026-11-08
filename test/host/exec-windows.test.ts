/**
 * Windows 上找可执行文件与启动包装脚本。
 *
 * Windows 环境下子进程拉起与 Agent 探测兼容性：
 * - npm 全局安装的 CLI 在 Windows 上落成 `.cmd`，Node 22 起直接 spawn 会抛 `EINVAL`；
 * - `where` 先给出无扩展名的 shim（`...\npm`），直接拿它去启动只会 ENOENT。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchDetached, runProcess, spawnChild, sanitizedEnv, whichBinary } from "../../src/host/boot/exec.js";
import { makeTempHome } from "../helpers/temp.js";

const isWindows = process.platform === "win32";

/** 跑一个子进程，收 stdout 与退出码。 */
function capture(bin: string, args: readonly string[], cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawnChild(bin, args, { cwd });
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", (error) => resolve({ code: null, out, err: `${err}${String(error)}` }));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe.skipIf(!isWindows)("Windows 包装脚本（.cmd）", () => {
  it("launches .cmd scripts with spaces, unicode, and special characters preserving arguments", async () => {
    const temp = makeTempHome();
    const dir = join(temp.home, "中文 目录");
    mkdirSync(dir, { recursive: true });
    const script = join(dir, "假 Agent.cmd");
    writeFileSync(
      script,
      `@echo off\r\n"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" -- %*\r\n`,
    );
    try {
      const result = await capture(script, ["--model", "sonnet", "a b", "c&d"], dir);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.out.trim())).toEqual(["--model", "sonnet", "a b", "c&d"]);
    } finally {
      rmSync(temp.home, { recursive: true, force: true });
    }
  }, 30_000);

  it("runProcess executes .cmd scripts correctly", async () => {
    const temp = makeTempHome();
    const script = join(temp.home, "说你好.cmd");
    writeFileSync(script, "@echo off\r\necho 你好\r\n");
    try {
      const result = await runProcess(script, [], { cwd: temp.home, timeoutMs: 10_000 });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("你好");
    } finally {
      rmSync(temp.home, { recursive: true, force: true });
    }
  }, 30_000);

  // launchDetached 与 spawnChild 走同一套包装：Kimi Code 的自动拉起用的就是它，
  // 裸 spawn 时错误会被 on("error") 吞掉，表现成"一直等到超时、说服务没起来"。
  it("launchDetached launches detached .cmd processes correctly", async () => {
    const temp = makeTempHome();
    // .cmd 的内容必须是纯 ASCII：cmd 按 OEM 代码页读脚本，中文会被读成乱码。
    const marker = join(temp.home, "marker.txt");
    const script = join(temp.home, "launcher.cmd");
    writeFileSync(script, `@echo off\r\necho launched > "${marker}"\r\n`);
    try {
      launchDetached(script);
      await waitFor(() => existsSync(marker), 5_000);
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(temp.home, { recursive: true, force: true });
    }
  }, 20_000);
});

/** 轮询等待一个条件成立，超时就返回 false。 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe.skipIf(!isWindows)("whichBinary 的候选顺序", () => {
  it("skips extensionless shims in favor of existing executable binaries", async () => {
    const found = await whichBinary("node", process.cwd());
    expect(found).not.toBeNull();
    expect(found!.toLowerCase().endsWith(".exe")).toBe(true);
  }, 20_000);

  it("falls back to .cmd when only wrapper script is present", async () => {
    const temp = makeTempHome();
    const script = join(temp.home, "只有包装.cmd");
    writeFileSync(script, "@echo off\r\n");
    try {
      const found = await whichBinary(script, temp.home);
      expect(found).toBe(script);
    } finally {
      rmSync(temp.home, { recursive: true, force: true });
    }
  }, 20_000);

  it("returns null safely without throwing when binary is not found", async () => {
    expect(await whichBinary("这个命令不存在-supercoder", process.cwd())).toBeNull();
  }, 20_000);
});

describe.skipIf(!isWindows)("子进程的环境变量白名单", () => {
  it("passes proxy and custom TLS cert env vars while filtering unrelated vars", () => {
    const saved = {
      HTTPS_PROXY: process.env["HTTPS_PROXY"],
      NO_PROXY: process.env["NO_PROXY"],
      NODE_EXTRA_CA_CERTS: process.env["NODE_EXTRA_CA_CERTS"],
    };
    process.env["HTTPS_PROXY"] = "http://127.0.0.1:7890";
    process.env["NO_PROXY"] = "localhost,127.0.0.1";
    process.env["NODE_EXTRA_CA_CERTS"] = "C:/tmp/ca.pem";
    process.env["SUPERCODER_TEST_SECRET"] = "should-not-leak";
    try {
      const env = sanitizedEnv();
      expect(env["HTTPS_PROXY"]).toBe("http://127.0.0.1:7890");
      expect(env["NO_PROXY"]).toBe("localhost,127.0.0.1");
      expect(env["NODE_EXTRA_CA_CERTS"]).toBe("C:/tmp/ca.pem");
      expect(env["SUPERCODER_TEST_SECRET"]).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete process.env["SUPERCODER_TEST_SECRET"];
    }
  });
});
