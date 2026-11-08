/**
 * 任务重试前置校验与同步拒绝响应验证。
 *
 * 任务分派可能跑几分钟，RPC 不能同步等它结束（会撞 120 秒超时）。
 * 但"存在性 / 未知态确认位 / 同任务在跑"这三条判断是同步的，
 * 必须在发起任务分派之前做，并且把 RpcFailure 原样交给 RPC 层。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHost, type RunningHost } from "../../src/host/index.js";
import { resolveAppPaths, sessionLogFile } from "../../src/host/boot/paths.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createTestBackend } from "../../src/host/boot/secrets.js";
import { openLog } from "../../src/host/session/log.js";
import { isRpcFailure } from "../../src/host/boot/failure.js";
import type { ErrorCode } from "../../src/shared/protocol/errors.js";
import type { MethodName, MethodParams, MethodResult } from "../../src/shared/protocol/methods.js";
import type { SessionMeta } from "../../src/shared/session/events.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();

function metaFor(workspaceId: string): SessionMeta {
  return {
    title: "重试测试",
    createdAt: "2026-01-01T00:00:00.000Z",
    workspace: workspaceId,
    language: "zh-CN",
  };
}

interface Fixture {
  readonly host: RunningHost;
  readonly home: string;
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  errorOf<M extends MethodName>(
    method: M,
    params: MethodParams<M>,
  ): Promise<{ code: ErrorCode; message: string }>;
  cleanup(): Promise<void>;
}

async function boot(home: string): Promise<Fixture> {
  const host = await startHost({
    home,
    port: 0,
    logger,
    skipInstanceLock: true,
    secretBackend: createTestBackend(),
    rendererDir: null,
  });
  const call = async <M extends MethodName>(method: M, params: MethodParams<M>) => {
    const frame = await host.rpc(method, params);
    if (frame.kind !== "result" || !frame.ok) {
      throw new Error(`期望成功，实际失败：${JSON.stringify(frame)}`);
    }
    return frame.result as MethodResult<M>;
  };
  const errorOf = async <M extends MethodName>(method: M, params: MethodParams<M>) => {
    const frame = await host.rpc(method, params);
    if (frame.kind !== "result" || frame.ok) {
      throw new Error(`期望失败，实际成功：${JSON.stringify(frame)}`);
    }
    return frame.error;
  };
  return {
    host,
    home,
    call,
    errorOf,
    cleanup: async () => {
      await host.close();
    },
  };
}

/** 直接往日志里写一条"结果未知"的任务分派，省去真跑一次外部 agent。 */
function seedUnknownTask(home: string, sessionId: string, workspaceId: string): void {
  const paths = resolveAppPaths({ SUPERCODER_HOME: home });
  const opened = openLog(sessionLogFile(paths, sessionId), metaFor(workspaceId));
  if (!opened.ok) throw new Error(`打开日志失败：${opened.error.message}`);
  const log = opened.value.log;
  log.append("delegation/spawn", {
    childId: "task_unknown",
    provider: "codex",
    agentId: "codex",
    instruction: "",
    goal: "改文案",
    mode: "read-only",
  });
  log.append("delegation/result", {
    childId: "task_unknown",
    result: { status: "unknown", observed: "进程没了", since: "2026-01-01T00:01:00.000Z" },
  });
  log.close();
}

describe("task.retry Validation and Rejection", () => {
  it("returns not_found when taskId does not exist", async () => {
    const temp = makeTempHome();
    const fixture = await boot(temp.home);
    try {
      const workspace = await fixture.call("workspace.add", {
        path: temp.home,
        name: "临时",
      });
      const session = await fixture.call("session.create", {
        workspaceId: workspace.id,
        title: "会话",
      });
      const error = await fixture.errorOf("task.retry", {
        sessionId: session.sessionId,
        taskId: "task_none",
        confirmSideEffects: false,
      });
      expect(error.code).toBe("not_found");
      expect(error.message).toContain("未找到指定任务");
    } finally {
      await fixture.cleanup();
      temp.cleanup();
    }
  });

  it("returns denied for unconfirmed unknown task and allows once confirmed", async () => {
    const temp = makeTempHome();
    const workspaceDir = join(temp.home, "ws");
    mkdirSync(workspaceDir, { recursive: true });
    const first = await boot(temp.home);
    const workspace = await first.call("workspace.add", { path: workspaceDir, name: "临时" });
    const session = await first.call("session.create", {
      workspaceId: workspace.id,
      title: "会话",
    });
    await first.cleanup();

    seedUnknownTask(temp.home, session.sessionId, workspace.id);

    const fixture = await boot(temp.home);
    try {
      const denied = await fixture.errorOf("task.retry", {
        sessionId: session.sessionId,
        taskId: "task_unknown",
        confirmSideEffects: false,
      });
      expect(denied.code).toBe("denied");
      expect(denied.message).toContain("前序任务状态未知");

      // 确认之后同步校验通过：RPC 立刻成功返回，任务分派在后台跑。
      const result = await fixture.call("task.retry", {
        sessionId: session.sessionId,
        taskId: "task_unknown",
        confirmSideEffects: true,
      });
      expect(result).toEqual({});
    } finally {
      await fixture.cleanup();
      temp.cleanup();
    }
  });
});

describe("DelegationRunner.assertRetryAllowed synchronous validation", () => {
  it("returns busy when task is already executing", async () => {
    const { DelegationRunner } = await import("../../src/host/delegation/run.js");
    const { ProviderSelect } = await import("../../src/host/delegation/provider-select.js");
    const { WorkspaceLocks } = await import("../../src/host/workspace/locks.js");
    const { SessionStore } = await import("../../src/host/session/store.js");
    const home = makeTempHome();
    const store = new SessionStore({ paths: home.paths, logger });
    const session = store.get(store.create("ws1", "挂着").sessionId);
    try {
      const gate: { open: () => void } = { open: () => undefined };
      const hanging = new Promise<void>((resolve) => {
        gate.open = () => {
          resolve();
        };
      });
      const select = new ProviderSelect([
        {
          id: "codex",
          label: "Codex",
          entries: [
            {
              level: 1,
              provider: {
                id: "codex",
                capabilities: {
                  readOnly: false,
                  resume: false,
                  effort: false,
                  streaming: false,
                  receiptStates: ["queued", "submitted", "returned"] as const,
                  fragility: "documented" as const,
                },
                detect: async () => ({ installed: true }),
                listSessions: async () => [],
                readSession: async () => [],
                delegate: async () => {
                  await hanging;
                  return { status: "ok", answer: "好", durationMs: 1 };
                },
                cancel: async () => undefined,
              },
            },
          ],
          probe: {
            providerId: "probe",
            locate: async () => null,
            listSessions: async () => [],
            readSession: async () => [],
          },
        },
      ]);
      const locks = new WorkspaceLocks();
      const runner = new DelegationRunner({ select, locks, logger });
      const running = runner.dispatch({
        session,
        workspaceId: "ws1",
        workspacePath: home.home,
        agentId: "codex",
        goal: "改文案",
        instruction: "",
        mode: "read-only",
        taskType: "general",
        signal: new AbortController().signal,
      });

      // 让 dispatch 走到"已经登记 inflight"的位置。
      const deadline = Date.now() + 2000;
      while (runner.inflightIds().length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const taskId = runner.inflightIds()[0] ?? "";
      expect(taskId).not.toBe("");

      const error = (() => {
        try {
          runner.assertRetryAllowed(session, taskId, true);
          return null;
        } catch (reason) {
          return reason;
        }
      })();
      expect(isRpcFailure(error)).toBe(true);
      if (isRpcFailure(error)) {
        expect(error.code).toBe("busy");
        expect(error.message).toContain("仍在执行中");
      }

      gate.open();
      await running;
    } finally {
      store.closeAll();
      home.cleanup();
    }
  });
});
