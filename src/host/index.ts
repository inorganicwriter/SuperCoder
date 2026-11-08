/**
 * Host 组合根。遵循架构设计规范。
 *
 * 这里是唯一把所有部件接线的地方：路径、日志、存储、通道、工具、任务分派、模型、MCP。
 * RPC 方法在这里逐行注册，少一个 `assertFullCoverage` 就会在启动时报错。
 */

import { copyFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { METHODS, type MethodName } from "../shared/protocol/methods.js";
import { resultErr, type RpcResponse } from "../shared/protocol/rpc.js";
import type { SessionEvent } from "../shared/session/events.js";
import { ensureDir, writeJsonAtomic } from "./boot/atomic.js";
import { DEFAULT_SETTINGS, SettingsStore, WorkspacesStore } from "./boot/config.js";
import { fail, messageOf } from "./boot/failure.js";
import { createLogger, type Logger } from "./boot/logger.js";
import { acquireInstanceLock, type LockOutcome } from "./boot/lock.js";
import type { LogIo } from "./session/log.js";
import { resolveAppPaths, sessionLogFile, type AppPaths } from "./boot/paths.js";
import { createEphemeralBackend, SecretStore, type SecretBackend } from "./boot/secrets.js";
import { createToken } from "./channel/auth.js";
import { SubscriptionHub } from "./channel/events.js";
import { RpcRouter, assertFullCoverage } from "./channel/rpc.js";
import { startChannel, type RunningChannel } from "./channel/server.js";
import { SessionStore } from "./session/store.js";
import { AgentHub } from "./agent/hub.js";
import { QuestionBroker } from "./agent/questions.js";
import { ToolRegistry } from "./tools/registry.js";
import { ApprovalBroker } from "./tools/approval.js";
import { ToolPipeline } from "./tools/pipeline.js";
import { registerBuiltinTools, type BuiltinToolServices } from "./tools/builtin/index.js";
import { DelegationRunner } from "./delegation/run.js";
import { ProviderSelect } from "./delegation/provider-select.js";
import { createProviderFamilies } from "./delegation/registry.js";
import { AgentPermissionPreferences } from "./delegation/permission-preferences.js";
import { AcpProvider } from "./delegation/providers/acp.js";
import { CodexAppServerProvider } from "./delegation/providers/codex-appserver.js";
import { AgentModelPreferences } from "./delegation/model-preferences.js";
import { ModelCatalog } from "./models/catalog.js";
import { agentModelConfig, checkAgentModel } from "./models/agent-model.js";
import type { AgentModelConfig } from "../shared/domain/delegation.js";
import type { Capsule } from "../shared/domain/capsule.js";
import { McpRegistry } from "./mcp/registry.js";
import { WorkspaceRegistry } from "./workspace/entity.js";
import { WorkspaceLocks } from "./workspace/locks.js";
import { isGitRepo, restoreFiles } from "./workspace/git.js";
import { collectRewindCandidates } from "./workspace/rewind.js";

export interface HostOptions {
  /** 覆盖数据目录（测试与便携模式）。 */
  readonly home?: string;
  readonly rendererDir?: string | null;
  readonly port?: number;
  readonly token?: string;
  readonly logger?: Logger;
  readonly secretBackend?: SecretBackend;
  readonly fetchImpl?: typeof fetch;
  /** 拿不到实例锁时是否继续（只有测试与 bench 会这么做）。 */
  readonly skipInstanceLock?: boolean;
  /** 注入日志文件操作（测试用：模拟写失败）。默认走 node:fs。 */
  readonly logIo?: LogIo;
}

export interface RunningHost {
  readonly port: number;
  readonly url: string;
  readonly token: string;
  readonly paths: AppPaths;
  readonly router: RpcRouter;
  /** 直接调 RPC（测试用；生产走 WebSocket，同一条分发路径）。 */
  rpc(method: MethodName, params?: unknown): Promise<RpcResponse>;
  close(): Promise<void>;
}

export async function startHost(options: HostOptions = {}): Promise<RunningHost> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.home !== undefined) env["SUPERCODER_HOME"] = options.home;
  const paths = resolveAppPaths(env);
  ensureDir(paths.home);
  ensureDir(paths.sessionsDir);
  ensureDir(paths.diagnosticsDir);

  const logger = options.logger ?? createLogger({ bindings: { app: "supercoder" } });
  let lock: LockOutcome | null = null;
  if (options.skipInstanceLock !== true) {
    const acquired = acquireInstanceLock(paths);
    if (!acquired.ok) fail("denied", acquired.reason);
    lock = acquired;
  }

  const settingsStore = new SettingsStore(paths);
  const loadedSettings = settingsStore.load();
  if (!loadedSettings.ok) {
    logger.warn({ error: loadedSettings.error.message }, "设置不可用，按默认值启动");
  }
  const workspaces = new WorkspaceRegistry(new WorkspacesStore(paths));
  const secrets = new SecretStore(
    paths.secretsFile,
    options.secretBackend ?? createEphemeralBackend(),
  );

  const sessions = new SessionStore({
    paths,
    logger,
    ...(options.logIo === undefined ? {} : { logIo: options.logIo }),
  });
  const scan = sessions.scanAll();
  if (scan.rejected.length > 0) logger.warn({ rejected: scan.rejected }, "有会话加载失败");

  const locks = new WorkspaceLocks();
  const agentPermissions = new AgentPermissionPreferences(join(paths.home, "agent-permissions.json"));
  const select = new ProviderSelect(() => createProviderFamilies({ homeDir: homedir(), configFile: join(paths.home, "agents.json"), allowPermissions: (id) => agentPermissions.get(id) === "allow" }));
  const agentModels = new AgentModelPreferences(join(paths.home, "agent-models.json"));
  const agentStatuses = async (force = false) => (await select.statuses(force)).map((agent) => {
    const selectedModel = agentModels.get(agent.id);
    const supportsPolicy = select.family(agent.id).entries.some((entry) => entry.provider instanceof AcpProvider || entry.provider instanceof CodexAppServerProvider);
    return { ...agent, ...(selectedModel === undefined ? {} : { selectedModel }), ...(supportsPolicy ? { permissionPolicy: agentPermissions.get(agent.id) } : {}) };
  });
  const runner = new DelegationRunner({ select, locks, logger });
  const models = new ModelCatalog({
    settings: settingsStore,
    secrets,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const agentModelDeps = { models, secrets };
  const modelConfigFor = (agentId: string, selection: string | undefined): AgentModelConfig | undefined =>
    agentModelConfig(agentId, selection, agentModelDeps);
  const questions = new QuestionBroker(logger);
  const approvals = new ApprovalBroker(logger);
  const registry = new ToolRegistry();

  const language = (): "zh-CN" | "en" => {
    const settings = settingsStore.load();
    return settings.ok ? settings.value.language : DEFAULT_SETTINGS.language;
  };
  const approvalPolicy = () => {
    const settings = settingsStore.load();
    return settings.ok ? settings.value.approvalPolicy : DEFAULT_SETTINGS.approvalPolicy;
  };
  const workspacePathOf = (workspaceId: string): string => {
    try {
      return workspaces.resolveRoot(workspaceId);
    } catch {
      return "";
    }
  };
  /** 工作区目录不存在时拒绝执行，避免在无效路径上执行文件与进程操作。 */
  const requireWorkspacePath = (workspaceId: string): string => {
    const root = workspacePathOf(workspaceId);
    if (root === "") {
      fail("not_found", "当前会话关联的工作区已不存在，请重新添加工作区。");
    }
    return root;
  };

  const builtinServices: BuiltinToolServices = {
    listAgents: () => agentStatuses(),
    // 模型配置在开跑之前校验：配置错误不该被 pipeline 记成"执行状态未知"。
    checkAgentModel: (agentId) => checkAgentModel(agentId, agentModels.get(agentId), agentModelDeps),
    dispatch: (input) => {
      const workspacePath = requireWorkspacePath(input.workspaceId);
      const selectedModel = agentModels.get(input.agentId);
      const modelConfig = modelConfigFor(input.agentId, selectedModel);
      return runner.dispatch({
        session: input.session,
        workspaceId: input.workspaceId,
        workspacePath,
        agentId: input.agentId,
        ...(selectedModel === undefined ? {} : { model: selectedModel }),
        ...(modelConfig === undefined ? {} : { modelConfig }),
        goal: input.goal,
        instruction: input.instruction,
        mode: input.mode,
        taskType: input.taskType,
        ...(input.resumeSessionId === undefined ? {} : { resumeSessionId: input.resumeSessionId }),
        ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
        signal: input.signal,
      });
    },
    task: (sessionId, taskId) => {
      const session = sessions.maybe(sessionId);
      if (session === null) return null;
      return session.view().tasks.find((task) => task.taskId === taskId) ?? null;
    },
    listProviderSessions: (agentId, page) => select.listSessions(agentId, "", page),
    readProviderSession: (agentId, sessionId, page) => select.readSession(agentId, sessionId, page),
    capsules: (workspaceId, sessionId) => sessions.capsules(workspaceId, sessionId),
    verificationCommand: () => {
      const settings = settingsStore.load();
      return settings.ok
        ? settings.value.verificationCommand
        : DEFAULT_SETTINGS.verificationCommand;
    },
    askUser: (input) => questions.ask(input),
  };
  registerBuiltinTools(registry, builtinServices);

  const pipeline = new ToolPipeline({ registry, approvals, policy: approvalPolicy, logger });
  const hub = new AgentHub({
    models,
    tools: pipeline,
    registry,
    approvals,
    questions,
    logger,
    language,
    workspacePathOf: (session) => workspacePathOf(session.meta.workspace),
    sharedContext: (session) => sharedContextFor(sessions.capsules(session.meta.workspace), session.sessionId, session.meta.createdAt),
  });
  const mcp = new McpRegistry({
    settings: settingsStore,
    secrets,
    logger,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  const router = new RpcRouter(logger);

  // —— system ——
  router.register("system.info", () => ({
    home: paths.home,
    platform: "win32" as const,
    dbPath: paths.sessionsDir,
  }));

  // —— workspace ——
  router.register("workspace.list", () => {
    const state = workspaces.list();
    return { activeId: state.activeId, items: [...state.items] };
  });
  router.register("workspace.add", (params) => workspaces.add(params.path, params.name));
  router.register("workspace.remove", (params) => {
    workspaces.remove(params.id);
    return {};
  });
  router.register("workspace.activate", (params) => {
    workspaces.activate(params.id);
    return {};
  });

  // —— session ——
  router.register("session.list", (params) => sessions.list(params.workspaceId));
  router.register("session.create", (params) => sessions.create(params.workspaceId, params.title));
  router.register("session.rename", (params) => {
    sessions.rename(params.sessionId, params.title);
    return {};
  });
  router.register("session.delete", (params) => {
    sessions.remove(params.sessionId);
    return {};
  });
  router.register("session.rebuild", (params) => {
    sessions.rebuild(params.sessionId);
    return {};
  });

  // —— message / turn ——
  router.register("message.send", (params) => {
    const session = sessions.get(params.sessionId);
    return hub.send({ session, text: params.text, attachments: params.attachments ?? [] });
  });
  router.register("turn.interrupt", (params) => {
    const session = sessions.get(params.sessionId);
    hub.interrupt(session, params.turnId);
    return {};
  });
  router.register("message.rewind", async (params) => {
    const session = sessions.get(params.sessionId);
    if (params.toSeq > session.lastSeq) {
      fail(
        "invalid_params",
        `回撤目标序号超出范围（最大为 ${session.lastSeq}）。`,
      );
    }
    const root = requireWorkspacePath(session.meta.workspace);
    const candidates = collectRewindCandidates(session.allEvents(), params.toSeq, root);
    // ：工作区不是 git 仓库时中止回撤——不猜文件内容，自建 diff 恢复会二次损坏。
    if (candidates.length > 0 && !isGitRepo(root)) {
      fail(
        "unsupported",
        `当前工作区未初始化 Git 仓库，无法执行文件回撤。请先在工作区初始化 Git 仓库并提交基线代码。`,
      );
    }
    // 先把文件恢复到位，再落盘两条事件（P2-5）：
    // 反过来会留下"用户要回撤"的悬空意图 —— 文件没恢复，也没有 rewind/completed。
    let restored: string[] = [];
    if (candidates.length > 0) {
      const result = await restoreFiles(root, candidates);
      if (!result.ok) {
        // 一条事件都不写：让状态停留在"没回撤过"，并且坦白可能已经有文件被动了。
        fail(
          "storage_failed",
          `回撤操作已中止：${result.error}。部分文件可能已被恢复，请自行核对工作区状态。`,
        );
      }
      restored = result.value.restored;
    }
    session.append("user/rewind", { toSeq: params.toSeq });
    session.append("rewind/completed", { toSeq: params.toSeq, restoredFiles: restored });
    return { restoredFiles: restored };
  });
  router.register("approval.respond", (params) => {
    sessions.get(params.sessionId);
    hub.respondApproval(params.callId, params.decision, params.remember);
    return {};
  });
  router.register("question.answer", (params) => {
    sessions.get(params.sessionId);
    hub.answerQuestion(params.questionId, params.answer);
    return {};
  });

  // —— task ——
  router.register("task.list", (params) => [...sessions.get(params.sessionId).view().tasks]);
  router.register("task.get", (params) => {
    const session = sessions.get(params.sessionId);
    const task = session.view().tasks.find((candidate) => candidate.taskId === params.taskId);
    if (task === undefined) {
      fail("not_found", `未找到指定任务：${params.taskId}。`);
    }
    return task;
  });
  router.register("task.cancel", (params) => {
    sessions.get(params.sessionId);
    if (!runner.interrupt(params.sessionId, params.taskId)) {
      fail(
        "not_found",
        `任务 ${params.taskId} 没有在运行，无需取消。`,
      );
    }
    return {};
  });
  router.register("task.retry", (params) => {
    const session = sessions.get(params.sessionId);
    const root = requireWorkspacePath(session.meta.workspace);
    // 同步校验先做：拒绝原因必须让调用方看见。
    // 通过之后就返回，任务分派在后台跑 —— 整次任务分派可能几分钟，不能同步等（会撞 120 秒超时）。
    const task = runner.assertRetryAllowed(session, params.taskId, params.confirmSideEffects);
    const modelConfig = modelConfigFor(task.agentId, task.selectedModel);
    const controller = new AbortController();
    void runner
      .retry({
        session,
        workspacePath: root,
        taskId: params.taskId,
        confirmSideEffects: params.confirmSideEffects,
        ...(modelConfig === undefined ? {} : { modelConfig }),
        signal: controller.signal,
      })
      .catch((error: unknown) => {
        logger.error({ error: messageOf(error), taskId: params.taskId }, "重试任务分派失败");
      });
    return {};
  });

  // —— agent ——
  router.register("agent.list", () => agentStatuses(false));
  router.register("agent.refresh", async () => {
    select.invalidate();
    return agentStatuses(true);
  });
  router.register("agent.model.set", (params) => {
    select.family(params.agentId);
    if (params.model?.startsWith("profile:")) modelConfigFor(params.agentId, params.model);
    agentModels.set(params.agentId, params.model);
    return {};
  });
  router.register("agent.permission.set", (params) => {
    const family = select.family(params.agentId);
    if (!family.entries.some((entry) => entry.provider instanceof AcpProvider || entry.provider instanceof CodexAppServerProvider)) fail("denied", "该 Agent 没有可管理的权限策略。");
    agentPermissions.set(params.agentId, params.policy);
    return {};
  });
  router.register("agent.models", (params) => select.listModels(params.agentId, requireWorkspacePath(params.workspaceId)));

  // —— model ——
  router.register("model.list", () => models.list());
  router.register("model.upsert", (params) => {
    models.upsert(params.profile);
    return {};
  });
  router.register("model.remove", (params) => {
    models.remove(params.id);
    return {};
  });
  router.register("model.test", (params) => models.test(params.id));

  // —— capsule ——
  router.register("capsule.list", (params) =>
    sessions.capsules(params.workspaceId, params.sessionId),
  );
  // 上下文胶囊的变更与移除通过向所属会话追加 capsule/saved 事件实现版本追踪。
  const capsuleIn = (sessionId: string, capsuleId: string) => {
    const session = sessions.get(sessionId);
    const capsule = session.view().capsules.find((item) => item.capsuleId === capsuleId);
    if (capsule === undefined) fail("not_found", `未找到指定的上下文胶囊：${capsuleId}。`);
    return { session, capsule };
  };
  router.register("capsule.update", (params) => {
    const { session, capsule } = capsuleIn(params.sessionId, params.capsuleId);
    session.append("capsule/saved", {
      capsuleId: capsule.capsuleId,
      action: "update",
      title: params.title,
      humanSummary: params.humanSummary,
      technicalHandoff: params.technicalHandoff,
      touchedFiles: [...capsule.touchedFiles],
      scope: params.scope,
    });
    return {};
  });
  router.register("capsule.remove", (params) => {
    const { session, capsule } = capsuleIn(params.sessionId, params.capsuleId);
    session.append("capsule/saved", {
      capsuleId: capsule.capsuleId,
      action: "remove",
      title: capsule.title,
      humanSummary: capsule.humanSummary,
      technicalHandoff: capsule.technicalHandoff,
      touchedFiles: [...capsule.touchedFiles],
      scope: capsule.scope,
    });
    return {};
  });

  // —— mcp ——
  router.register("mcp.list", () => mcp.list());
  router.register("mcp.add", (params) => {
    mcp.add(params.server);
    return {};
  });
  router.register("mcp.remove", async (params) => {
    await mcp.remove(params.id);
    return {};
  });
  router.register("mcp.auth", async (params) => {
    try {
      return { url: await mcp.authorizationUrl(params.id) };
    } catch (error) {
      // 拿不到授权元数据是对方服务器的问题，不是我们的内部错误：给 provider_failed 与可执行提示。
      fail("provider_failed", messageOf(error));
    }
  });

  // —— secret ——
  router.register("secret.set", (params) => {
    const saved = secrets.set(params.key, params.value);
    if (!saved.ok) fail("storage_failed", saved.error);
    return {};
  });
  router.register("secret.has", (params) => ({ has: secrets.has(params.key) }));
  router.register("secret.clear", (params) => {
    const cleared = secrets.clear(params.key);
    if (!cleared.ok) fail("storage_failed", cleared.error);
    return {};
  });

  // —— diagnostics ——
  router.register("diagnostics.export", (params) => ({
    path: exportDiagnostics(paths, params.sessionId, logger),
  }));

  assertFullCoverage(router);
  assertMethodCount();

  const hubEvents = new SubscriptionHub(logger);
  const token = options.token ?? createToken();
  const subscriptions = new Map<string, () => void>();
  /** 老前端没有"会话"概念：服务端记住最近打开的那个，写操作默认落在它上面。 */
  const channel: RunningChannel = await startChannel({
    router,
    hub: hubEvents,
    token,
    rendererDir: options.rendererDir ?? null,
    workspaceRoot: (workspaceId: string) => workspaces.resolveRoot(workspaceId),
    logger,
    ...(options.port === undefined ? {} : { port: options.port }),
    onSubscribe: async (sessionId, sinceSeq): Promise<SessionEvent[]> => {
      // 这里必须走 load：重启后第一次订阅时会话还没进内存，用 maybe 会既无补发也无增量。
      const session = sessions.load(sessionId);
      if (session === null) return [];
      const previous = subscriptions.get(sessionId);
      if (previous !== undefined) previous();
      const unsubscribe = session.subscribe((events) => hubEvents.publish(sessionId, events));
      subscriptions.set(sessionId, unsubscribe);
      return session.since(sinceSeq);
    },
  });

  void mcp.connectEnabled().catch((error: unknown) => {
    logger.warn({ error: messageOf(error) }, "MCP 自动连接失败");
  });

  return {
    port: channel.port,
    url: channel.url,
    token,
    paths,
    router,
    async rpc(method, params = {}) {
      const parsed = METHODS[method].params.safeParse(params);
      if (!parsed.success) {
        return resultErr(`local-${randomUUID()}`, "invalid_params", `${method} 参数不符`);
      }
      return router.dispatch({ kind: "rpc", rpcId: `local-${randomUUID()}`, method, params });
    },
    async close() {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      hub.shutdown();
      await mcp.close();
      await channel.close();
      sessions.closeAll();
      if (lock !== null && lock.ok) lock.release();
    },
  };
}

/** 方法数量变化时同步检查协议与注册面。 */
function assertMethodCount(): void {
  const count = Object.keys(METHODS).length;
  if (count !== 39) throw new Error(`RPC 方法数量应为 39，实际 ${count}`);
}

/** 诊断包：脱敏设置 + 会话日志 + 说明；不含任何密钥。 */
function exportDiagnostics(paths: AppPaths, sessionId: string | undefined, logger: Logger): string {
  const dir = join(paths.diagnosticsDir, `${Date.now()}-${randomUUID().slice(0, 8)}`);
  ensureDir(dir);
  const settings = readIfPresent(paths.settingsFile);
  writeJsonAtomic(join(dir, "report.json"), {
    createdAt: new Date().toISOString(),
    app: "supercoder",
    sessionId: sessionId ?? null,
    platform: process.platform,
    versions: process.versions,
    settings: settings === null ? null : redactSettings(settings),
    sessionLog: sessionId === undefined ? null : "session-log.jsonl",
  });
  if (sessionId !== undefined) {
    const log = sessionLogFile(paths, sessionId);
    if (existsSync(log)) copyFileSync(log, join(dir, "session-log.jsonl"));
  }
  writeJsonAtomic(join(dir, "README.json"), {
    note: "诊断包只包含设置与日志；密钥存放在 secrets.bin，已加密且不在本包内。",
  });
  logger.info({ dir }, "导出诊断包");
  return dir;
}

function readIfPresent(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function redactSettings(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = { ...(parsed as Record<string, unknown>) };
    for (const key of Object.keys(record)) {
      if (/secret|token|key|password/i.test(key)) record[key] = "[redacted]";
    }
    return record;
  } catch {
    return null;
  }
}

/** 只保留最近若干个诊断包，避免无限增长。 */
export async function pruneDiagnostics(paths: AppPaths, keep = 10): Promise<void> {
  const entries = readdirSync(paths.diagnosticsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
    await rm(join(paths.diagnosticsDir, name), { recursive: true, force: true });
  }
}

/**
 * 新对话带入的共享上下文：本工作区其它对话里保存的工作区级胶囊，且是本对话开始前就有的。
 * 同一对话里的内容本来就在历史里，不重复带入；对话中途别处新存的胶囊也不会突然冒出来。
 * 按胶囊的创建时间判断：已经带入的胶囊被编辑后，带入的是编辑后的内容，而不是从此消失。
 */
export function sharedContextFor(capsules: readonly Capsule[], sessionId: string, createdAt: string, limit = 8_000): string {
  const blocks: string[] = [];
  let used = 0;
  for (const capsule of capsules) {
    if (capsule.scope !== "workspace" || capsule.sessionId === sessionId || capsule.createdAt > createdAt) continue;
    const files = capsule.touchedFiles.length > 0 ? `Files: ${capsule.touchedFiles.join(", ")}` : "";
    const block = [`## ${capsule.title}`, capsule.humanSummary, capsule.technicalHandoff, files]
      .filter((part) => part.trim() !== "")
      .join("\n");
    if (used + block.length > limit) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join("\n\n");
}
