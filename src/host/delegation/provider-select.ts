/**
 * 四级能力阶梯与探测缓存。遵循架构设计规范。
 *
 * 规则：
 * - 同一执行者按 1→2→3 找一个能用的接入方式；都没有就看第 4 级能不能读历史
 * - 第 4 级只能读，永远不能用来做写任务
 * - 探测结果缓存 60 秒，`agent.refresh` 强制重探
 */

import type {
  DelegationProvider,
  ProviderLevel,
  ProviderModel,
  ProviderPage,
  ProviderSessionSummary,
  ProviderStatus,
  StoreProbe,
} from "../../shared/domain/provider.js";
import type { DelegationEvent } from "../../shared/domain/delegation.js";
import { fail } from "../boot/failure.js";

export const PROBE_TTL_MS = 60_000;

export interface LadderEntry {
  readonly level: 1 | 2 | 3;
  readonly provider: DelegationProvider;
}

export interface FamilySpec {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly LadderEntry[];
  readonly probe: StoreProbe;
}

export interface ResolvedProvider {
  readonly provider: DelegationProvider;
  readonly level: ProviderLevel;
}

export interface ProviderSelectDeps {
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class ProviderSelect {
  private cache: { at: number; statuses: ProviderStatus[] } | null = null;
  /**
   * 族清单也要缓存：构建它要同步查注册表（找已安装程序），
   * 而 `agent.list`、探测、解析都会走到这里。探测缓存过期时一并重建。
   */
  private familiesCache: { at: number; families: readonly FamilySpec[] } | null = null;

  constructor(
    private readonly families: readonly FamilySpec[] | (() => readonly FamilySpec[]),
    private readonly deps: ProviderSelectDeps = {},
  ) {}

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get ttl(): number {
    return this.deps.ttlMs ?? PROBE_TTL_MS;
  }

  familiesList(): FamilySpec[] {
    if (typeof this.families !== "function") return [...this.families];
    if (this.familiesCache !== null && this.now - this.familiesCache.at < this.ttl) return [...this.familiesCache.families];
    const families = this.families();
    this.familiesCache = { at: this.now, families };
    return [...families];
  }

  /** 探测（带 60 秒缓存）。`force` 对应 `agent.refresh`。 */
  async statuses(force = false): Promise<ProviderStatus[]> {
    if (!force && this.cache !== null && this.now - this.cache.at < this.ttl) {
      return this.cache.statuses;
    }
    const checkedAt = new Date(this.now).toISOString();
    const statuses: ProviderStatus[] = [];
    for (const family of this.familiesList()) {
      statuses.push(await this.probeFamily(family, checkedAt));
    }
    this.cache = { at: this.now, statuses };
    return statuses;
  }

  private async probeFamily(family: FamilySpec, checkedAt: string): Promise<ProviderStatus> {
    let reason: string | undefined;
    for (const entry of family.entries) {
      let installation;
      try {
        installation = await entry.provider.detect();
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (installation.installed) {
        const fragility = entry.provider.capabilities.fragility;
        return {
          id: family.id,
          label: family.label,
          installed: true,
          level: entry.level,
          fragility,
          compat: fragility !== "official",
          capabilities: entry.provider.capabilities,
          checkedAt,
          ...(installation.version === undefined ? {} : { version: installation.version }),
          ...(installation.binaryPath === undefined ? {} : { binaryPath: installation.binaryPath }),
        };
      }
      reason = installation.reason ?? reason;
    }

    const root = await family.probe.locate("").catch(() => null);
    if (root !== null) {
      return {
        id: family.id,
        label: family.label,
        installed: true,
        level: 4,
        fragility: "reverse-engineered",
        compat: true,
        capabilities: {
          readOnly: true,
          resume: false,
          effort: false,
          streaming: false,
          receiptStates: [],
          fragility: "reverse-engineered",
        },
        checkedAt,
        binaryPath: root,
        // 有接入方式只是暂时不可用（例如桌面版没开）时，把那个原因给人看，而不是笼统的"只能读历史"。
        reason: family.entries.length > 0 && reason !== undefined ? reason : "只探测到私有存储：只能读取历史会话，不能任务分派。",
      };
    }

    return {
      id: family.id,
      label: family.label,
      installed: false,
      level: null,
      fragility: null,
      compat: false,
      capabilities: {
        readOnly: false,
        resume: false,
        effort: false,
        streaming: false,
        receiptStates: [],
        fragility: "official",
      },
      checkedAt,
      ...(reason === undefined ? { reason: "没有找到这个执行者" } : { reason }),
    };
  }

  /** 任务分派必须落在 1–3 级；只有第 4 级时明确拒绝。 */
  async resolve(agentId: string): Promise<ResolvedProvider> {
    return (await this.resolveCandidates(agentId))[0]!;
  }

  /** Candidates are only alternatives until a provider actually submits a task. */
  async resolveCandidates(agentId: string): Promise<ResolvedProvider[]> {
    const family = this.family(agentId);
    const available: ResolvedProvider[] = [];
    for (const entry of family.entries) {
      const installation = await entry.provider.detect().catch(() => ({ installed: false }));
      if (installation.installed) available.push({ provider: entry.provider, level: entry.level });
    }
    if (available.length > 0) return available;
    const root = await family.probe.locate("").catch(() => null);
    if (root !== null) {
      fail(
        "denied",
        `${family.label} 仅检测到本地历史记录，无法派发任务。请安装并登录对应 CLI 工具。`,
      );
    }
    fail("not_found", `${family.label} 未安装或未登录，请安装后重新探测。`);
  }

  family(id: string): FamilySpec {
    const families = this.familiesList();
    const found = families.find((family) => family.id === id);
    if (found === undefined) {
      fail("invalid_params", `未知的执行者：${id}（可用：${families.map((f) => f.id).join(", ")}）`);
    }
    return found;
  }

  /** 读历史：优先用能用的接入方式，实在没有就退回第 4 级只读探测。 */
  async listSessions(agentId: string, workspace: string, page: ProviderPage): Promise<ProviderSessionSummary[]> {
    const family = this.family(agentId);
    for (const entry of family.entries) {
      const installation = await entry.provider.detect().catch(() => ({ installed: false }));
      if (!installation.installed) continue;
      const sessions = await entry.provider.listSessions(workspace, page).catch(() => []);
      if (sessions.length > 0) return sessions;
    }
    return family.probe.listSessions(workspace, page);
  }

  async listModels(agentId: string, workspace: string): Promise<ProviderModel[]> {
    const family = this.family(agentId);
    let lastError: unknown;
    for (const entry of family.entries) {
      if (!entry.provider.listModels || !(await entry.provider.detect().catch(() => ({ installed: false }))).installed) continue;
      try { return await entry.provider.listModels(workspace); } catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
    fail("not_found", `${family.label} 未提供可读取的模型清单。`);
  }

  async readSession(agentId: string, sessionId: string, page: ProviderPage): Promise<DelegationEvent[]> {
    const family = this.family(agentId);
    for (const entry of family.entries) {
      const installation = await entry.provider.detect().catch(() => ({ installed: false }));
      if (!installation.installed) continue;
      const events = await entry.provider.readSession(sessionId, page).catch(() => []);
      if (events.length > 0) return events;
    }
    return family.probe.readSession(sessionId, page);
  }

  invalidate(): void {
    this.cache = null;
    this.familiesCache = null;
  }
}
