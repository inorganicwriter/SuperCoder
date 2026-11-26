/**
 * 自定义外部 Agent 配置存储（`agents.json`）。
 *
 * 与 `delegation/registry.ts` 共用 `CustomAgentsSchema`，
 * 仅允许添加/编辑/删除非内置 ID 的自定义 ACP 或 Command Agent。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { CustomAgentSchema, type CustomAgent } from "../../shared/domain/custom-agent.js";
import { ensureDir, writeJsonAtomic } from "../boot/atomic.js";
import { fail } from "../boot/failure.js";
import { CustomAgentsSchema } from "./registry.js";

export class CustomAgentsStore {
  constructor(private readonly file: string) {}

  private readDoc(): Record<string, unknown> & { agents: CustomAgent[] } {
    if (!existsSync(this.file)) return { agents: [] };
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      const doc = CustomAgentsSchema.parse(raw);
      return {
        ...doc,
        agents: doc.agents.map((item) => CustomAgentSchema.parse(item)),
      };
    } catch {
      return { agents: [] };
    }
  }

  list(): CustomAgent[] {
    return this.readDoc().agents;
  }

  upsert(input: CustomAgent, reservedIds: readonly string[]): CustomAgent {
    const parsed = CustomAgentSchema.parse(input);
    if (reservedIds.includes(parsed.id)) {
      fail("invalid_params", `不能使用内置 Agent 标识：${parsed.id}。`);
    }
    const doc = this.readDoc();
    const index = doc.agents.findIndex((item) => item.id === parsed.id);
    const nextAgents =
      index >= 0
        ? doc.agents.map((item, at) => (at === index ? parsed : item))
        : [...doc.agents, parsed];
    ensureDir(dirname(this.file));
    writeJsonAtomic(this.file, { ...doc, agents: nextAgents });
    return parsed;
  }

  remove(id: string): boolean {
    const doc = this.readDoc();
    const nextAgents = doc.agents.filter((item) => item.id !== id);
    if (nextAgents.length === doc.agents.length) return false;
    ensureDir(dirname(this.file));
    writeJsonAtomic(this.file, { ...doc, agents: nextAgents });
    return true;
  }
}
