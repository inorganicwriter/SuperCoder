/**
 * 启动握手的 token 避免出现在命令行参数与页面 URL 中。
 *
 * 原来两处都漏：
 * - `webPreferences.additionalArguments` 里带 `--sc-token=<token>`：渲染进程的命令行
 *   对同机其它进程可见（任务管理器/进程wmic/ps 都能读），token 等于明文广播。
 * - `loadURL(...?token=...)` 又把同一个凭据塞进 URL：历史记录、日志、崩溃转储里都会留痕。
 *
 * 在非 GUI 环境下通过源码级断言验证引导凭据的传递机制：
 * preload 走 IPC 同步取 bootstrap，主进程通过 ipcMain 应答。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

function source(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf8");
}

describe("Electron IPC Security Token", () => {
  it("token is never exposed on command line arguments", () => {
    const main = source("electron/main.cts");
    expect(main).not.toContain("--sc-token");
    // 端口与数据目录也一并改由 IPC 传递，命令行里干脆不留 sc- 前缀的参数。
    expect(main).not.toContain("--sc-port");
  });

  it("token is never embedded into webview URL query string", () => {
    const main = source("electron/main.cts");
    expect(main).not.toContain("?token=");
    expect(main).toContain("loadURL(handle.url)");
  });

  it("main process exposes bootstrap via ipcMain and preload retrieves synchronously", () => {
    const main = source("electron/main.cts");
    const preload = source("electron/preload.cts");
    expect(main).toContain("ipcMain");
    expect(main).toContain("sc:bootstrap");
    expect(preload).toContain("sc:bootstrap");
    expect(preload).toContain("sendSync");
    // preload 仅通过 IPC 同步获取引导凭据，不从 argv 获取。
    expect(preload).not.toContain("sc-token");
    expect(preload).not.toContain("process.argv");
  });
});
