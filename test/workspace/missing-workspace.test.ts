/**
 * 找不到工作区时必须显式失败。遵循架构设计规范。
 *
 * `resolveRoot` 早期在查不到时回落到 `process.cwd()` —— 也就是应用自己的安装目录。
 * 工作区被移除之后，历史会话仍指向那个 id，于是回撤会在**应用目录**里跑
 * `git checkout -- <paths>`，跨目录破坏性写入；验证命令也会在应用目录里执行。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "../../src/host/index.js";
import { resolveAppPaths, sessionLogFile } from "../../src/host/boot/paths.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createTestBackend } from "../../src/host/boot/secrets.js";
import { WorkspacesStore } from "../../src/host/boot/config.js";
import { WorkspaceRegistry } from "../../src/host/workspace/entity.js";
import { openLog } from "../../src/host/session/log.js";
import type { ErrorCode } from "../../src/shared/protocol/errors.js";
import type { MethodName, MethodParams, MethodResult } from "../../src/shared/protocol/methods.js";
import type { SessionMeta } from "../../src/shared/session/events.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

describe("Unknown Workspace Security Guard", () => {
  it("returns empty string without falling back to cwd when workspace is unresolvable", () => {
    const temp = makeTempHome();
    try {
      const registry = new WorkspaceRegistry(new WorkspacesStore(temp.paths));
      const root = registry.resolveRoot("does-not-exist");
      expect(root).toBe("");
      expect(root).not.toBe(process.cwd());
    } finally {
      temp.cleanup();
    }
  });

  it("rejects rewind operations after workspace removal without invoking git", async () => {
    const temp = makeTempHome();
    const workspaceDir = join(temp.home, "ws");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "a.txt"), "原样\n", "utf8");

    // 一个会话只能有一个写入方（C4）：先用一个 host 建好工作区与会话，关掉之后再补日志。
    const boot = async (): Promise<RunningHost> =>
      await startHost({
        home: temp.home,
        port: 0,
        logger,
        skipInstanceLock: true,
        secretBackend: createTestBackend(),
        rendererDir: null,
      });
    const callOn = async <M extends MethodName>(
      host: RunningHost,
      method: M,
      params: MethodParams<M>,
    ) => {
      const frame = await host.rpc(method, params);
      if (frame.kind !== "result" || !frame.ok) {
        throw new Error(`期望成功，实际失败：${JSON.stringify(frame)}`);
      }
      return frame.result as MethodResult<M>;
    };

    const first = await boot();
    let workspaceId = "";
    let sessionId = "";
    try {
      const workspace = await callOn(first, "workspace.add", { path: workspaceDir, name: "临时" });
      const session = await callOn(first, "session.create", {
        workspaceId: workspace.id,
        title: "回撤测试",
      });
      workspaceId = workspace.id;
      sessionId = session.sessionId;
    } finally {
      await first.close();
    }

    try {
      // 造一个"回撤会想动文件"的历史：快照里有 a.txt。
      const paths = resolveAppPaths({ SUPERCODER_HOME: temp.home });
      const opened = openLog(sessionLogFile(paths, sessionId), {
        title: "回撤测试",
        createdAt: "2026-01-01T00:00:00.000Z",
        workspace: workspaceId,
        language: "zh-CN",
      } satisfies SessionMeta);
      if (!opened.ok) throw new Error(`打开日志失败：${opened.error.message}`);
      const log = opened.value.log;
      log.append("snapshot/taken", {
        taskId: "task_1",
        files: [{ path: "a.txt", mtimeMs: 1, size: 3 }],
      });
      log.append("user/message", { text: "随便说一句", attachments: [] });
      log.close();

      const host = await boot();
      try {
        await callOn(host, "workspace.remove", { id: workspaceId });

        // toSeq = 0：快照（第 1 条）落在回撤区间里，回撤会想动 a.txt。
        const frame = await host.rpc("message.rewind", {
          sessionId,
          toSeq: 0,
        });
        expect(frame.kind).toBe("result");
        if (frame.kind !== "result" || frame.ok) {
          throw new Error(`期望被拒绝，实际成功：${JSON.stringify(frame)}`);
        }
        const error = frame.error as { code: ErrorCode; message: string };
        expect(error.code).toBe("not_found");
        expect(error.message).toContain("工作区");
      } finally {
        await host.close();
      }

      // 一条事件都没写：拒绝发生在落盘之前。
      const after = openLog(sessionLogFile(paths, sessionId), {
        title: "回撤测试",
        createdAt: "2026-01-01T00:00:00.000Z",
        workspace: workspaceId,
        language: "zh-CN",
      } satisfies SessionMeta);
      if (!after.ok) throw new Error(`重开日志失败：${after.error.message}`);
      expect(after.value.events.some((event) => event.type === "user/rewind")).toBe(false);
      after.value.log.close();
    } finally {
      temp.cleanup();
    }
  });
});
