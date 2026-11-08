/**
 * 回撤的落盘顺序。遵循架构设计规范。
 *
 * 早期顺序是"先写 user/rewind → 再恢复文件 → 再写 rewind/completed"。
 * 恢复失败（git checkout 非零退出）时日志里已经有一条"用户要回撤"，
 * 但文件没恢复、也没有 rewind/completed：重开会话看到的是一个永远悬着的意图，
 * 而界面完全不提"其实有文件已经被动过"。
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHost } from "../../src/host/index.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createTestBackend } from "../../src/host/boot/secrets.js";
import { sessionLogFile } from "../../src/host/boot/paths.js";
import type { ErrorCode } from "../../src/shared/protocol/errors.js";
import type { MethodName, MethodParams, MethodResult } from "../../src/shared/protocol/methods.js";
import type { SessionMeta } from "../../src/shared/session/events.js";
import { openLog } from "../../src/host/session/log.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

describe("Rewind Failure Log Handling", () => {
  it("preserves log atomicity and warns of possible external modifications on restore failure", async () => {
    const temp = makeTempHome();
    const workspaceDir = join(temp.home, "ws");
    mkdirSync(workspaceDir, { recursive: true });
    git(workspaceDir, ["init", "--quiet"]);
    git(workspaceDir, ["config", "user.email", "test@example.com"]);
    git(workspaceDir, ["config", "user.name", "Test"]);
    writeFileSync(join(workspaceDir, "a.txt"), "初版\n", "utf8");
    git(workspaceDir, ["add", "a.txt"]);
    git(workspaceDir, ["commit", "--quiet", "-m", "init"]);

    const boot = async () =>
      await startHost({
        home: temp.home,
        port: 0,
        logger,
        skipInstanceLock: true,
        secretBackend: createTestBackend(),
        rendererDir: null,
      });
    const callOn = async <M extends MethodName>(
      host: Awaited<ReturnType<typeof boot>>,
      method: M,
      params: MethodParams<M>,
    ): Promise<MethodResult<M>> => {
      const frame = await host.rpc(method, params);
      if (frame.kind !== "result" || !frame.ok) {
        throw new Error(`期望成功，实际失败：${JSON.stringify(frame)}`);
      }
      return frame.result as MethodResult<M>;
    };

    const meta = (workspaceId: string): SessionMeta => ({
      title: "回撤失败",
      createdAt: "2026-01-01T00:00:00.000Z",
      workspace: workspaceId,
      language: "zh-CN",
    });

    const first = await boot();
    let sessionId = "";
    let workspaceId = "";
    try {
      const workspace = await callOn(first, "workspace.add", { path: workspaceDir, name: "临时" });
      workspaceId = workspace.id;
      const session = await callOn(first, "session.create", {
        workspaceId,
        title: "回撤失败",
      });
      sessionId = session.sessionId;
    } finally {
      await first.close();
    }

    // 快照里记一个 git 完全不认识的路径：恢复时 `git checkout -- ghost.txt` 必然失败。
    const logPath = sessionLogFile(temp.paths, sessionId);
    const opened = openLog(logPath, meta(workspaceId));
    if (!opened.ok) throw new Error(`打开日志失败：${opened.error.message}`);
    opened.value.log.append("snapshot/taken", {
      taskId: "task_1",
      files: [{ path: "ghost.txt", mtimeMs: 1, size: 3 }],
    });
    opened.value.log.append("user/message", { text: "随便说一句", attachments: [] });
    opened.value.log.close();
    const before = readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "").length;

    const host = await boot();
    try {
      const frame = await host.rpc("message.rewind", { sessionId, toSeq: 0 });
      expect(frame.kind).toBe("result");
      if (frame.kind !== "result" || frame.ok) {
        throw new Error(`期望失败，实际成功：${JSON.stringify(frame)}`);
      }
      const error = frame.error as { code: ErrorCode; message: string };
      expect(error.code).toBe("storage_failed");
      expect(error.message).toContain("回撤操作已中止");
      // 失败提示必须承认"可能有文件已经被动过"。
      expect(error.message).toContain("自行核对");
    } finally {
      await host.close();
    }

    const after = readFileSync(logPath, "utf8").split("\n").filter((line) => line !== "");
    const types = after
      .map((line) => JSON.parse(line) as { type?: string })
      .map((event) => event.type)
      .filter((type): type is string => type !== undefined);
    // 一条事件都没写：既没有 user/rewind，也没有 rewind/completed。
    // （首行的 fields 清单里也有 "user/rewind" 字样，所以必须解析 type，不能搜字符串。）
    expect(after).toHaveLength(before);
    expect(types).not.toContain("user/rewind");
    expect(types).not.toContain("rewind/completed");
    temp.cleanup();
  });
});
