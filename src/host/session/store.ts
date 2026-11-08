/**
 * 会话集合：列出、创建、打开、重建、删除。遵循架构设计规范–。
 *
 * 打开过的会话留在内存里（句柄缓存）；没打开过的按 `index.json` 报价，
 * 索引不可信时退回"读日志重算 + 顺手把索引修好"。
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Capsule } from "../../shared/domain/capsule.js";
import type { SessionSummary } from "../../shared/session/derive.js";
import type { SessionMeta, SessionStatus } from "../../shared/session/events.js";
import { err, ok, type Result } from "../../shared/result.js";
import type { Logger } from "../boot/logger.js";
import { fail } from "../boot/failure.js";
import {
  isSafeId,
  sessionDir,
  sessionIndexFile,
  sessionLogFile,
  type AppPaths,
} from "../boot/paths.js";
import { ensureDir } from "../boot/atomic.js";
import { DeriveCache } from "./derive-cache.js";
import { SessionHandle, loadErrorToFailure } from "./handle.js";
import { buildIndex, readSessionIndex, writeSessionIndex } from "./index.js";
import type { LoadError } from "./reader.js";
import type { LogIo } from "./log.js";

export interface SessionStoreDeps {
  readonly paths: AppPaths;
  readonly logger: Logger;
  /** 注入文件操作（测试用）：写失败要能在 RPC 层表现为 storage_failed。 */
  readonly logIo?: LogIo;
  /** 会话语言跟随用户输入的语言；创建时由调用方决定。 */
  readonly defaultLanguage?: string;
}

const DEFAULT_TITLE = "新会话";

export class SessionStore {
  private readonly open = new Map<string, SessionHandle>();
  private readonly cache: DeriveCache;
  private readonly defaultLanguage: string;

  constructor(private readonly deps: SessionStoreDeps) {
    this.defaultLanguage = deps.defaultLanguage ?? "zh-CN";
    this.cache = new DeriveCache((sessionId, header) => ({
      sessionId,
      workspaceId: header.meta.workspace,
    }));
  }

  /** 启动时把所有会话扫一遍，等于执行  的三步（早发现损坏，别等用户点开）。 */
  scanAll(): { opened: number; repaired: number; rejected: Array<{ sessionId: string; message: string }> } {
    const rejected: Array<{ sessionId: string; message: string }> = [];
    let opened = 0;
    let repaired = 0;
    for (const sessionId of this.listSessionIds()) {
      const loaded = SessionHandle.open({
        sessionId,
        meta: this.fallbackMeta(sessionId),
        workspaceId: "",
        logFile: sessionLogFile(this.deps.paths, sessionId),
        indexPath: sessionIndexFile(this.deps.paths, sessionId),
        repair: true,
        ...(this.deps.logIo === undefined ? {} : { logIo: this.deps.logIo }),
      });
      if (!loaded.ok) {
        rejected.push({ sessionId, message: loaded.error.message });
        continue;
      }
      opened += 1;
      if (loaded.value.repairedBytes > 0) repaired += 1;
      const handle = loaded.value.handle;
      try {
        closeAbandonedTurn(handle);
      } catch (error) {
        this.deps.logger.warn({ sessionId, error: String(error) }, "收尾上次未结束的回合失败");
      }
      try {
        handle.writeIndex();
      } catch {
        // 索引只是缓存：写不进去时下次读取会按日志重算。
      }
      handle.close();
    }
    return { opened, repaired, rejected };
  }

  listSessionIds(): string[] {
    const dir = this.deps.paths.sessionsDir;
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeId(entry.name))
      .map((entry) => entry.name)
      .filter((name) => existsSync(sessionLogFile(this.deps.paths, name)))
      .sort();
  }

  list(workspaceId: string): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    for (const sessionId of this.listSessionIds()) {
      const summary = this.summaryOf(sessionId);
      if (summary === null) continue;
      if (workspaceId !== "" && summary.workspace !== workspaceId) continue;
      summaries.push(summary);
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 单个会话的摘要：优先索引，索引不可信就重算并修好索引。 */
  summaryOf(sessionId: string): SessionSummary | null {
    const handle = this.open.get(sessionId);
    if (handle) return handle.summary();
    const indexPath = sessionIndexFile(this.deps.paths, sessionId);
    const logFile = sessionLogFile(this.deps.paths, sessionId);
    // 校验底层日志文件是否存在，避免在索引残留时显示已删除的会话条目。
    if (!existsSync(logFile)) return null;
    const index = readSessionIndex(indexPath, sessionId);
    if (index !== null) {
      return {
        sessionId,
        title: index.header.title,
        createdAt: index.header.createdAt,
        updatedAt: index.header.updatedAt,
        workspace: index.header.workspace,
        language: index.header.language,
        status: index.header.status as SessionStatus,
        lastSeq: index.lastSeq,
        counts: index.counts,
      };
    }
    const hit = this.cache.refresh(sessionId, logFile);
    if (hit === null) return null;
    const lastMessage = hit.view.messages[hit.view.messages.length - 1];
    try {
      writeSessionIndex(
        indexPath,
        buildIndex({ sessionId, header: hit.header, view: hit.view, anchors: hit.anchors }),
      );
    } catch (error) {
      this.deps.logger.warn({ sessionId, error: String(error) }, "索引重建写入失败");
    }
    return {
      sessionId,
      title: hit.header.meta.title,
      createdAt: hit.header.meta.createdAt,
      updatedAt: lastMessage?.at ?? hit.header.meta.createdAt,
      workspace: hit.header.meta.workspace,
      language: hit.header.meta.language,
      status: hit.view.status,
      lastSeq: hit.view.lastSeq,
      counts: hit.view.counts,
    };
  }

  create(workspaceId: string, title?: string): { sessionId: string } {
    const sessionId = randomUUID();
    const dir = sessionDir(this.deps.paths, sessionId);
    ensureDir(dir);
    const meta: SessionMeta = {
      title: title !== undefined && title.trim() !== "" ? title : DEFAULT_TITLE,
      createdAt: new Date().toISOString(),
      workspace: workspaceId,
      language: this.defaultLanguage,
    };
    const loaded = SessionHandle.open({
      sessionId,
      meta,
      workspaceId,
      logFile: sessionLogFile(this.deps.paths, sessionId),
      indexPath: sessionIndexFile(this.deps.paths, sessionId),
      repair: true,
      ...(this.deps.logIo === undefined ? {} : { logIo: this.deps.logIo }),
    });
    if (!loaded.ok) throw loadErrorToFailure(loaded.error);
    const handle = loaded.value.handle;
    handle.writeIndex();
    this.open.set(sessionId, handle);
    return { sessionId };
  }

  /** 打开（或取回已打开的）会话。损坏时抛 RpcFailure，并带上可执行提示。 */
  get(sessionId: string): SessionHandle {
    if (!isSafeId(sessionId)) fail("invalid_params", `会话 id 不合法：${sessionId}`);
    const existing = this.open.get(sessionId);
    if (existing) return existing;
    const logFile = sessionLogFile(this.deps.paths, sessionId);
    if (!existsSync(logFile)) fail("not_found", `找不到会话 ${sessionId} 的日志`);
    const loaded = SessionHandle.open({
      sessionId,
      meta: this.fallbackMeta(sessionId),
      workspaceId: "",
      logFile,
      indexPath: sessionIndexFile(this.deps.paths, sessionId),
      repair: true,
      ...(this.deps.logIo === undefined ? {} : { logIo: this.deps.logIo }),
    });
    if (!loaded.ok) throw loadErrorToFailure(loaded.error);
    const handle = loaded.value.handle;
    this.open.set(sessionId, handle);
    this.cache.prime(sessionId, logFile, handle.logHeader, handle.view(), handle.anchorsSnapshot());
    return handle;
  }

  /**
   * 订阅路径用：会话在磁盘上就按需打开，没有就返回 null（不抛）。
   *
   * 只查内存缓存的话，应用重启之后的第一次订阅既拿不到补发、也挂不上增量监听。
   */
  load(sessionId: string): SessionHandle | null {
    if (!isSafeId(sessionId)) return null;
    const existing = this.open.get(sessionId);
    if (existing) return existing;
    const logFile = sessionLogFile(this.deps.paths, sessionId);
    if (!existsSync(logFile)) return null;
    const loaded = SessionHandle.open({
      sessionId,
      meta: this.fallbackMeta(sessionId),
      workspaceId: "",
      logFile,
      indexPath: sessionIndexFile(this.deps.paths, sessionId),
      repair: true,
      ...(this.deps.logIo === undefined ? {} : { logIo: this.deps.logIo }),
    });
    if (!loaded.ok) throw loadErrorToFailure(loaded.error);
    const handle = loaded.value.handle;
    this.open.set(sessionId, handle);
    this.cache.prime(sessionId, logFile, handle.logHeader, handle.view(), handle.anchorsSnapshot());
    return handle;
  }

    maybe(sessionId: string): SessionHandle | null {
    return this.open.get(sessionId) ?? null;
  }

  rename(sessionId: string, title: string): void {
    const handle = this.get(sessionId);
    handle.rename(title);
    this.cache.invalidate(sessionId);
  }

  remove(sessionId: string): void {
    if (!isSafeId(sessionId)) fail("invalid_params", `会话 id 不合法：${sessionId}`);
    const handle = this.open.get(sessionId);
    if (handle) {
      if (handle.isBusy) fail("busy", "会话正在执行回合，先中断再删除");
      handle.close();
      this.open.delete(sessionId);
    }
    const dir = sessionDir(this.deps.paths, sessionId);
    if (!existsSync(dir)) fail("not_found", `找不到会话 ${sessionId}`);
    rmSync(dir, { recursive: true, force: true });
    this.cache.invalidate(sessionId);
  }

  /** 删掉 `index.json` 再按日志重算。 */
  rebuild(sessionId: string): SessionSummary {
    const handle = this.open.get(sessionId);
    if (handle) {
      handle.dropIndex();
      handle.writeIndex();
      return handle.summary();
    }
    const indexPath = sessionIndexFile(this.deps.paths, sessionId);
    rmSync(indexPath, { force: true });
    this.cache.invalidate(sessionId);
    const summary = this.summaryOf(sessionId);
    if (summary === null) throw loadErrorToFailure(missingLog(sessionId));
    return summary;
  }

  capsules(workspaceId: string, sessionId?: string): Capsule[] {
    const ids = sessionId === undefined ? this.listSessionIds() : [sessionId];
    const result: Capsule[] = [];
    for (const id of ids) {
      const handle = this.open.get(id);
      if (handle) {
        for (const capsule of handle.capsules()) {
          if (capsule.workspaceId === "" || workspaceId === "" || capsule.workspaceId === workspaceId) {
            result.push(capsule);
          }
        }
        continue;
      }
      const hit = this.cache.refresh(id, sessionLogFile(this.deps.paths, id));
      if (hit === null) continue;
      for (const capsule of hit.view.capsules) {
        if (workspaceId === "" || capsule.workspaceId === workspaceId) result.push(capsule);
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** 关掉全部句柄（进程退出、测试清理）。 */
  closeAll(): void {
    for (const handle of this.open.values()) handle.close();
    this.open.clear();
    this.cache.clear();
  }

  /** 索引里的工作区是权威值；句柄未打开时用空工作区占位，由调用方补。 */
  private fallbackMeta(sessionId: string): SessionMeta {
    const index = readSessionIndex(sessionIndexFile(this.deps.paths, sessionId), sessionId);
    if (index !== null) {
      return {
        title: index.header.title,
        createdAt: index.header.createdAt,
        workspace: index.header.workspace,
        language: index.header.language,
      };
    }
    return {
      title: DEFAULT_TITLE,
      createdAt: new Date().toISOString(),
      workspace: "",
      language: this.defaultLanguage,
    };
  }
}

function missingLog(sessionId: string): LoadError {
  return {
    code: "missing",
    message: `找不到会话 ${sessionId} 的日志`,
    hint: "刷新会话列表；若确实被删除，请重新创建会话。",
  };
}

/** 便于组合根判断：会话是否存在且可读。 */
export function sessionExists(paths: AppPaths, sessionId: string): Result<boolean, LoadError> {
  if (!isSafeId(sessionId)) return err(missingLog(sessionId));
  return ok(existsSync(sessionLogFile(paths, sessionId)));
}

/** 任务分派还没结算的状态：进程退出时它们可能已经动过工作区。 */
const IN_FLIGHT_TASK_STATES = new Set(["spawned", "queued", "submitted", "received"]);

/**
 * 启动时收尾上次进程退出时还没结束的回合。
 *
 * 启动扫描发生在任何回合开始之前，此刻日志里"开着"的回合只能是上次进程留下的：
 * 审批、提问已经没有人在等，任务分派的子进程也随宿主一起没了。不补这一笔，
 * 界面上会留着点了没反应的审批卡片，会话一直显示"执行中"。
 *
 * - 还没结算的任务分派记为 unknown（C7：可能已经动过工作区，不能当成失败）
 * - 回合本身：中途有工具或任务分派在执行就记 unknown，否则记 interrupted
 */
function closeAbandonedTurn(handle: SessionHandle): void {
  const events = handle.allEvents();
  let lastStart = 0;
  let lastEnd = 0;
  for (const event of events) {
    if (event.type === "turn/start") lastStart = event.seq;
    if (event.type === "turn/end") lastEnd = event.seq;
  }
  if (lastStart === 0 || lastEnd > lastStart) return;

  const view = handle.view();
  const since = new Date().toISOString();
  let uncertain = false;
  for (const task of view.tasks) {
    if (!IN_FLIGHT_TASK_STATES.has(task.state)) continue;
    uncertain = true;
    handle.append("delegation/result", {
      childId: task.childId,
      result: { status: "unknown", observed: "应用在任务分派进行中退出，无法确认这次任务分派是否改动了工作区", since },
    });
  }
  if (view.tools.some((tool) => tool.state === "pending" || tool.state === "running")) uncertain = true;
  handle.append("turn/end", { status: uncertain ? "unknown" : "interrupted", reason: "process_exit" });
}
