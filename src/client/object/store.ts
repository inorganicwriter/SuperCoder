/**
 * 客户端状态。遵循架构设计规范。
 *
 * 界面不自己算业务状态：会话视图一律用 `src/shared/session/derive` 的投影，
 * 与服务端共享相同的纯函数状态派生逻辑，保证界面状态与事件日志投影一致。
 */

import { SessionDerivation, type DerivedView } from "../../shared/session/derive.js";
import { isTransientEvent, type SessionEvent } from "../../shared/session/events.js";
import type { SessionSummary } from "../../shared/session/derive.js";
import type { Capsule } from "../../shared/domain/capsule.js";
import type { McpServer } from "../../shared/domain/mcp.js";
import type { ModelProfile, ModelProfileView } from "../../shared/domain/model.js";
import type { ProviderStatus } from "../../shared/domain/provider.js";
import type { ProviderModel } from "../../shared/domain/provider.js";
import type { TaskView } from "../../shared/domain/task.js";
import type { Workspace } from "../../shared/domain/workspace.js";
import type { MethodName, MethodParams, MethodResult } from "../../shared/protocol/methods.js";
import { Connection, type ConnectionStatus } from "./connection.js";
import { t, type Locale } from "../locale/index.js";

/** store 需要的最小传输面：真实现是 `Connection`，测试可以给假的。 */
export interface ClientTransport {
  readonly currentStatus: ConnectionStatus;
  /** 当前订阅的会话（没有订阅时为 null），界面用它标"正在跟哪个会话"。 */
  readonly subscribedSession: string | null;
  connect(): void;
  close(): void;
  rpc<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  subscribe(sessionId: string, sinceSeq?: number): void;
  unsubscribe(): void;
}

export type ClientStoreOptions =
  | {
      readonly transport: ClientTransport;
      readonly locale: Locale;
      /** 追问时等上一轮停下的上限，只有测试会改它。 */
      readonly busyWaitMs?: number;
    }
  | {
      readonly port: number;
      readonly token: string;
      readonly locale: Locale;
      /** 重连退避基数，只有测试会改它。 */
      readonly retryBaseMs?: number;
    };

export interface ClientState {
  readonly status: ConnectionStatus;
  readonly statusDetail: string | null;
  readonly workspaces: readonly Workspace[];
  readonly activeWorkspaceId: string;
  readonly sessions: readonly SessionSummary[];
  readonly activeSessionId: string | null;
  readonly view: DerivedView | null;
  readonly tasks: readonly TaskView[];
  readonly agents: readonly ProviderStatus[];
  readonly models: readonly ModelProfileView[];
  readonly servers: readonly McpServer[];
  readonly capsules: readonly Capsule[];
  readonly error: string | null;
  readonly busy: boolean;
}

const EMPTY: ClientState = {
  status: "closed",
  statusDetail: null,
  workspaces: [],
  activeWorkspaceId: "",
  sessions: [],
  activeSessionId: null,
  view: null,
  tasks: [],
  agents: [],
  models: [],
  servers: [],
  capsules: [],
  error: null,
  busy: false,
};

export class ClientStore {
  private state: ClientState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private events: SessionEvent[] = [];
  /** 已经进过视图的最大 seq：重连补发与重复推送都靠它挡住。 */
  private appliedSeq = 0;
  private pendingTurn: string | null = null;
  /** 增量投影器：每批只 apply 新事件，不再从头重算。 */
  private derivation: SessionDerivation | null = null;
  readonly connection: ClientTransport;

  private readonly busyWaitMs: number;

  constructor(options: ClientStoreOptions) {
    void options.locale;
    this.busyWaitMs = "busyWaitMs" in options && options.busyWaitMs !== undefined ? options.busyWaitMs : 15_000;
    if ("transport" in options) {
      this.connection = options.transport;
      return;
    }
    this.connection = new Connection({
      port: options.port,
      token: options.token,
      ...(options.retryBaseMs === undefined ? {} : { retryBaseMs: options.retryBaseMs }),
      onStatus: (status, detail) => {
        this.patch({
          status,
          ...(detail === undefined ? {} : { statusDetail: detail }),
          // 重连成功就把断线期间攒下的错误清掉：连接已经恢复，旧提示只会误导。
          ...(status === "open" ? { error: null } : {}),
        });
        if (status === "open") void this.refreshAll();
      },
      onEvents: (sessionId, events) => this.applyEvents(sessionId, events),
    });
  }

  /** 已进入视图的事件镜像：按 seq 严格递增、没有重复（诊断与测试都看它）。 */
  get appliedEvents(): readonly SessionEvent[] {
    return this.events;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = (): ClientState => this.state;

  private patch(partial: Partial<ClientState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  private fail(error: unknown): void {
    this.patch({ error: error instanceof Error ? error.message : String(error) });
  }

  private clearError(): void {
    if (this.state.error !== null) this.patch({ error: null });
  }

  dismissError(): void {
    this.clearError();
  }

  start(): void {
    this.connection.connect();
  }

  stop(): void {
    this.connection.close();
  }

  async refreshAll(): Promise<void> {
    try {
      const workspaces = await this.connection.rpc("workspace.list", {});
      let activeId = this.state.activeWorkspaceId;
      if (activeId === "" && workspaces.items.length > 0) {
        activeId = workspaces.activeId !== "" ? workspaces.activeId : (workspaces.items[0]?.id ?? "");
      }
      this.patch({ workspaces: workspaces.items, activeWorkspaceId: activeId });
      const [agents, models, servers] = await Promise.all([
        this.connection.rpc("agent.list", {}),
        this.connection.rpc("model.list", {}),
        this.connection.rpc("mcp.list", {}),
      ]);
      this.patch({ agents, models, servers });
      if (activeId !== "") await this.loadSessions(activeId);
    } catch (error) {
      this.fail(error);
    }
  }

  async loadSessions(workspaceId: string): Promise<void> {
    try {
      const sessions = await this.connection.rpc("session.list", { workspaceId });
      this.patch({ sessions });
      // 与 Python 版一致：切到工作区后自动打开第一个会话，
      // 否则用户看到的是空态，还得先点一下侧栏才能开始说话。
      if (this.state.activeSessionId === null && sessions.length > 0) {
        const first = sessions[0];
        if (first !== undefined) await this.selectSession(first.sessionId);
      }
    } catch (error) {
      this.fail(error);
    }
  }

  async selectWorkspace(id: string): Promise<void> {
    this.patch({ activeWorkspaceId: id, activeSessionId: null, view: null, tasks: [], capsules: [] });
    this.connection.unsubscribe();
    await this.connection.rpc("workspace.activate", { id }).catch(() => undefined);
    await this.loadSessions(id);
  }

  async addWorkspace(path: string): Promise<void> {
    this.clearError();
    try {
      const workspace = await this.connection.rpc("workspace.add", { path });
      await this.refreshAll();
      await this.selectWorkspace(workspace.id);
    } catch (error) {
      this.fail(error);
    }
  }

  async removeWorkspace(id: string): Promise<void> {
    this.clearError();
    try {
      await this.connection.rpc("workspace.remove", { id });
      await this.refreshAll();
    } catch (error) {
      this.fail(error);
    }
  }

  async createSession(): Promise<void> {
    if (this.state.activeWorkspaceId === "") {
      this.patch({ error: t("workspace.none") });
      return;
    }
    this.clearError();
    try {
      const created = await this.connection.rpc("session.create", {
        workspaceId: this.state.activeWorkspaceId,
      });
      await this.loadSessions(this.state.activeWorkspaceId);
      await this.selectSession(created.sessionId);
    } catch (error) {
      this.fail(error);
    }
  }

  async selectSession(sessionId: string): Promise<void> {
    this.clearError();
    this.events = [];
    this.appliedSeq = 0;
    this.derivation = new SessionDerivation({
      sessionId,
      workspaceId: this.state.activeWorkspaceId,
    });
    this.pendingTurn = null;
    this.patch({ activeSessionId: sessionId, view: null, tasks: [], capsules: [] });
    this.connection.subscribe(sessionId, 0);
    try {
      const tasks = await this.connection.rpc("task.list", { sessionId });
      this.patch({ tasks });
      await this.loadCapsules();
    } catch (error) {
      this.fail(error);
    }
  }

  /** 读整个工作区的胶囊（各对话保存的共享上下文都在这里）。 */
  async loadCapsules(): Promise<void> {
    if (this.state.activeWorkspaceId === "") return;
    try {
      const capsules = await this.connection.rpc("capsule.list", { workspaceId: this.state.activeWorkspaceId });
      this.patch({ capsules });
    } catch (error) {
      this.fail(error);
    }
  }

  async updateCapsule(input: MethodParams<"capsule.update">): Promise<boolean> {
    try {
      await this.connection.rpc("capsule.update", input);
      await this.loadCapsules();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  async removeCapsule(sessionId: string, capsuleId: string): Promise<void> {
    try {
      await this.connection.rpc("capsule.remove", { sessionId, capsuleId });
      await this.loadCapsules();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * 传输层入口：收到一批事件。公开是因为它就是 store 的"入站边"——
   * 真实现由 `Connection` 调，测试可以直接投喂。
   */
  applyEvents(sessionId: string, events: readonly SessionEvent[]): void {
    if (sessionId !== this.state.activeSessionId) return;
    const accepted = this.acceptNew(events);
    if (accepted.apply.length === 0) return;
    for (const event of accepted.persisted) this.events.push(event);
    this.derivation ??= new SessionDerivation({
      sessionId,
      workspaceId: this.state.activeWorkspaceId,
    });
    // 按到达顺序投给派生器：流式增量必须在同 step 的正式消息之前生效。
    for (const event of accepted.apply) this.derivation.apply(event);
    const view = this.derivation.view();
    const turnEnded = accepted.persisted.some((event) => event.type === "turn/end");
    const busy = view.status === "running" && !turnEnded;
    this.patch({
      view,
      tasks: [...view.tasks],
      // 共享上下文面板列的是整个工作区：别的对话的胶囊沿用上次读到的，当前对话的取最新派生结果。
      capsules: [...this.state.capsules.filter((capsule) => capsule.sessionId !== sessionId), ...view.capsules],
      busy,
      ...(turnEnded ? {} : {}),
    });
    if (turnEnded) {
      void this.connection
        .rpc("session.list", { workspaceId: this.state.activeWorkspaceId })
        .then((sessions) => this.patch({ sessions }))
        .catch(() => undefined);
    }
  }

  /**
   * 入站分流：
   *
   * - 瞬态（`request/delta`）直接交给派生器，不推进 `appliedSeq`、不进 `this.events`；
   *   它们借下一次写入的 seq，按 seq 过滤会把紧随其后的正式事件误判成重复。
   * - 持久事件只收 `seq > appliedSeq`：重连补发与重复批次都靠这一条挡住。
   *
   * `apply` 是"要投给派生器的"，按到达顺序；`persisted` 是"要进镜像的"，
   * 因此 `appliedEvents` 始终等于已落盘事件的镜像，不会混进瞬态。
   */
  private acceptNew(events: readonly SessionEvent[]): {
    apply: SessionEvent[];
    persisted: SessionEvent[];
  } {
    const apply: SessionEvent[] = [];
    const persisted: SessionEvent[] = [];
    for (const event of events) {
      if (isTransientEvent(event.type)) {
        apply.push(event);
        continue;
      }
      if (event.seq <= this.appliedSeq) continue;
      this.appliedSeq = event.seq;
      apply.push(event);
      persisted.push(event);
    }
    return { apply, persisted };
  }

  /** 发送一条消息。返回 false 表示没发出去（调用方应当把输入内容还给用户，别静默丢掉）。 */
  async send(text: string): Promise<boolean> {
    // 首页的输入框发消息时还没有会话：先建一个再发，否则这条消息会被静默丢掉。
    if (this.state.activeSessionId === null) await this.createSession();
    // 正在处理时追问：先打断当前这一轮，等它停下再发（宿主一次只跑一轮）。
    if (this.state.busy) {
      await this.interrupt();
      await this.waitIdle(this.busyWaitMs);
      // 打断落在一个不响应中止的长工具调用上时，回合不会立刻停：这时宿主仍会回 busy，
      // 与其发出去丢掉，不如停下来把内容还给用户。
      if (this.state.busy) {
        this.patch({ error: t("composer.stillBusy") });
        return false;
      }
    }
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return false;
    this.clearError();
    try {
      const result = await this.connection.rpc("message.send", { sessionId, text, attachments: [] });
      this.pendingTurn = result.turnId;
      // 事件可能早于 RPC 回复到达（回合结束时尤为明显）：依据视图状态计算，避免 busy 状态无法解除。
      const view = this.state.view;
      this.patch({ busy: view === null || view.status === "running" });
      return true;
    } catch (error) {
      this.fail(error);
      this.patch({ busy: false });
      return false;
    }
  }

  async interrupt(): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return;
    // 不知道 turnId（切换会话、刷新之后）时传空串：宿主会中断这个会话当前的那一轮。
    const turnId = this.pendingTurn ?? "";
    try {
      await this.connection.rpc("turn.interrupt", { sessionId, turnId });
    } catch (error) {
      this.fail(error);
    }
  }

  /** 等当前回合结束（视图不再是 running），最多等 timeoutMs。 */
  private async waitIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.state.busy && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async rewind(toSeq: number): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return;
    this.clearError();
    try {
      await this.connection.rpc("message.rewind", { sessionId, toSeq });
    } catch (error) {
      this.fail(error);
    }
  }

  async respondApproval(callId: string, decision: "allow" | "deny", remember: "none" | "turn" | "workspace"): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return;
    try {
      await this.connection.rpc("approval.respond", { sessionId, callId, decision, remember });
    } catch (error) {
      this.fail(error);
    }
  }

  async answerQuestion(questionId: string, answer: string): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return;
    try {
      await this.connection.rpc("question.answer", { sessionId, questionId, answer });
    } catch (error) {
      this.fail(error);
    }
  }

  /** 改名。传 sessionId 就改那一条（列表行上的"改名"），不传就改当前会话。 */
  async renameSession(title: string, sessionId = this.state.activeSessionId): Promise<void> {
    if (sessionId === null || title.trim() === "") return;
    try {
      await this.connection.rpc("session.rename", { sessionId, title: title.trim() });
      await this.loadSessions(this.state.activeWorkspaceId);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * 删除一条对话（日志、索引、任务记录一起删，宿主侧不可恢复）。
   *
   * 删除的是当前会话时，先清掉订阅与派生器再重载列表：`loadSessions` 会在没有
   * 活动会话时打开第一条，视图因此不会停在已删除的会话上。
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    this.clearError();
    try {
      await this.connection.rpc("session.delete", { sessionId });
    } catch (error) {
      this.fail(error);
      return false;
    }
    if (this.state.activeSessionId === sessionId) {
      this.connection.unsubscribe();
      this.derivation = null;
      this.events = [];
      this.appliedSeq = 0;
      this.pendingTurn = null;
      this.patch({ activeSessionId: null, view: null, tasks: [], capsules: [], busy: false });
    }
    await this.loadSessions(this.state.activeWorkspaceId);
    // 这个会话保存过的胶囊也一起没了，共享上下文面板要跟着刷新。
    await this.loadCapsules();
    return true;
  }

  async refreshAgents(): Promise<void> {
    try {
      this.patch({ agents: await this.connection.rpc("agent.refresh", {}) });
    } catch (error) {
      this.fail(error);
    }
  }

  async setAgentModel(agentId: string, model: string | null): Promise<void> {
    try {
      await this.connection.rpc("agent.model.set", { agentId, model });
      this.patch({ agents: await this.connection.rpc("agent.list", {}) });
    } catch (error) { this.fail(error); }
  }

  async setAgentPermission(agentId: string, policy: "allow" | "deny"): Promise<void> {
    try { await this.connection.rpc("agent.permission.set", { agentId, policy }); this.patch({ agents: await this.connection.rpc("agent.list", {}) }); }
    catch (error) { this.fail(error); }
  }

  async listAgentModels(agentId: string): Promise<ProviderModel[] | null> {
    try { return await this.connection.rpc("agent.models", { agentId, workspaceId: this.state.activeWorkspaceId }); }
    catch (error) { this.fail(error); return null; }
  }

  async retryTask(taskId: string, confirmSideEffects: boolean): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return;
    try {
      await this.connection.rpc("task.retry", { sessionId, taskId, confirmSideEffects });
    } catch (error) {
      this.fail(error);
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    const sessionId = this.state.activeSessionId;
    if (sessionId === null) return;
    try {
      await this.connection.rpc("task.cancel", { sessionId, taskId });
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * 重取模型档案。`hasKey` 是宿主查密钥算出来的派生字段，
   * 档案或密钥一变就要重取，否则界面停在旧判断上（例如刚填完密钥还显示"缺少密钥"）。
   */
  private async reloadModels(): Promise<void> {
    this.patch({ models: await this.connection.rpc("model.list", {}) });
  }

  /** 写入已经成功之后的刷新：失败只提示，不改写入的结论。 */
  private async reloadModelsAfterWrite(): Promise<void> {
    try {
      await this.reloadModels();
    } catch (error) {
      this.fail(error);
    }
  }

  async saveModel(profile: ModelProfile): Promise<boolean> {
    try {
      await this.connection.rpc("model.upsert", { profile });
    } catch (error) {
      this.fail(error);
      return false;
    }
    await this.reloadModelsAfterWrite();
    return true;
  }

  async removeModel(id: string): Promise<void> {
    try {
      await this.connection.rpc("model.remove", { id });
      await this.reloadModels();
    } catch (error) {
      this.fail(error);
    }
  }

  async testModel(id: string): Promise<string> {
    try {
      const result = await this.connection.rpc("model.test", { id });
      return result.message;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** 问 host 这个键有没有存过密钥。密钥本身永远不回到界面。 */
  async hasSecret(key: string): Promise<boolean> {
    try {
      const result = (await this.connection.rpc("secret.has", { key })) as { has?: boolean };
      return result.has === true;
    } catch {
      return false;
    }
  }

  async setSecret(key: string, value: string): Promise<boolean> {
    try {
      await this.connection.rpc("secret.set", { key, value });
    } catch (error) {
      this.fail(error);
      return false;
    }
    // 密钥属于模型档案时，hasKey 会跟着变：重取一次，别让界面停在旧判断上。
    await this.reloadModelsAfterWrite();
    return true;
  }

  async addMcp(server: {
    id: string;
    label: string;
    transport: "stdio" | "http";
    target: string;
    args: string[];
    enabled: boolean;
  }): Promise<void> {
    try {
      await this.connection.rpc("mcp.add", { server });
      this.patch({ servers: await this.connection.rpc("mcp.list", {}) });
    } catch (error) {
      this.fail(error);
    }
  }

  async removeMcp(id: string): Promise<void> {
    try {
      await this.connection.rpc("mcp.remove", { id });
      this.patch({ servers: await this.connection.rpc("mcp.list", {}) });
    } catch (error) {
      this.fail(error);
    }
  }

  async authorizeMcp(id: string): Promise<string> {
    try {
      const result = await this.connection.rpc("mcp.auth", { id });
      return result.url;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async exportDiagnostics(): Promise<string> {
    try {
      const sessionId = this.state.activeSessionId;
      const result = await this.connection.rpc(
        "diagnostics.export",
        sessionId === null ? {} : { sessionId },
      );
      return result.path;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}
