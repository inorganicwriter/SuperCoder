/**
 * Superagent 配置与按会话绑定的外部原生线程 ID 持久化。
 *
 * - `superagent.json`：记录当前主控驱动（模型档案 `model` 或指定外部 `agent`）。
 * - `superagent-sessions.json`：记录 `(sessionId, agentId)` 对应的外部原生会话及写入序号 `atSeq`，
 *   用于在正常追问时续话、在 `user/rewind` 回撤到绑定前时自动丢弃旧线程。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DEFAULT_SUPERAGENT_CONFIG,
  SuperagentConfigSchema,
  type SuperagentConfig,
} from "../../shared/domain/superagent.js";
import { writeJsonAtomic } from "../boot/atomic.js";

const ThreadBindingSchema = z.object({
  nativeSessionId: z.string().min(1),
  atSeq: z.number().int().nonnegative(),
});

const SessionsStoreSchema = z.record(z.string(), z.record(z.string(), ThreadBindingSchema));

export interface SuperagentSessionThread {
  readonly nativeSessionId: string;
  readonly atSeq: number;
}

export class SuperagentPreferences {
  private readonly configFile: string;
  private readonly sessionsFile: string;

  constructor(homeDir: string) {
    this.configFile = join(homeDir, "superagent.json");
    this.sessionsFile = join(homeDir, "superagent-sessions.json");
  }

  get(): SuperagentConfig {
    if (!existsSync(this.configFile)) return DEFAULT_SUPERAGENT_CONFIG;
    try {
      const raw: unknown = JSON.parse(readFileSync(this.configFile, "utf8"));
      const parsed = SuperagentConfigSchema.safeParse(raw);
      return parsed.success ? parsed.data : DEFAULT_SUPERAGENT_CONFIG;
    } catch {
      return DEFAULT_SUPERAGENT_CONFIG;
    }
  }

  set(config: SuperagentConfig): SuperagentConfig {
    const parsed = SuperagentConfigSchema.parse(config);
    writeJsonAtomic(this.configFile, parsed);
    return parsed;
  }

  private readAllThreads(): Record<string, Record<string, SuperagentSessionThread>> {
    if (!existsSync(this.sessionsFile)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(this.sessionsFile, "utf8"));
      const parsed = SessionsStoreSchema.safeParse(raw);
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  getSessionThread(sessionId: string, agentId: string): SuperagentSessionThread | null {
    const binding = this.readAllThreads()[sessionId]?.[agentId];
    return binding ?? null;
  }

  setSessionThread(sessionId: string, agentId: string, nativeSessionId: string, atSeq: number): void {
    const all = this.readAllThreads();
    all[sessionId] = {
      ...all[sessionId],
      [agentId]: { nativeSessionId, atSeq },
    };
    writeJsonAtomic(this.sessionsFile, all);
  }

  clearSessionThread(sessionId: string, agentId?: string): void {
    const all = this.readAllThreads();
    const sessionMap = all[sessionId];
    if (sessionMap === undefined) return;
    if (agentId === undefined) {
      delete all[sessionId];
    } else {
      delete sessionMap[agentId];
      if (Object.keys(sessionMap).length === 0) {
        delete all[sessionId];
      }
    }
    writeJsonAtomic(this.sessionsFile, all);
  }
}
