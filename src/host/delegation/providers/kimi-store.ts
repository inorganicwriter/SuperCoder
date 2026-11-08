/**
 * Kimi Code 私有存储探测。
 *
 * Kimi Code 桌面版没有 CLI、没有 ACP、也没有 headless 入口（解剖 app.asar 确认过），
 * 因此它只能作为"只读历史"接入：能看它自己聊过什么，不能任务分派。
 *
 * 目录结构：`~/.kimi-code/sessions/<workspace>/session_<id>/`
 *   - `state.json`               会话元数据（标题、cwd、更新时间）
 *   - `agents/main/wire.jsonl`   事件流，正文在 `agent.message.appended`
 *
 * 这是逆向出来的布局，`fragility: "reverse-engineered"`：界面必须显示兼容模式角标。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DelegationEvent } from "../../../shared/domain/delegation.js";
import type {
  ProviderPage,
  ProviderSessionSummary,
  StoreProbe,
} from "../../../shared/domain/provider.js";

interface KimiSessionFile {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly wireFile: string;
}

export interface KimiStoreDeps {
  /** `~/.kimi-code/sessions` 的绝对路径。 */
  readonly sessionsDir: string;
}

export class KimiStoreProbe implements StoreProbe {
  readonly providerId = "kimi-code";

  constructor(private readonly deps: KimiStoreDeps) {}

  async locate(_workspace: string): Promise<string | null> {
    try {
      return statSync(this.deps.sessionsDir).isDirectory() ? this.deps.sessionsDir : null;
    } catch {
      return null;
    }
  }

  async listSessions(_workspace: string, page: ProviderPage): Promise<ProviderSessionSummary[]> {
    const sessions = this.scan().sort((left, right) => right.updatedAt - left.updatedAt);
    return sessions.slice(page.offset, page.offset + page.limit).map((session) => ({
      sessionId: session.id,
      title: session.title,
      updatedAt: new Date(session.updatedAt).toISOString(),
    }));
  }

  async readSession(sessionId: string, page: ProviderPage): Promise<DelegationEvent[]> {
    const file = this.scan().find((session) => session.id === sessionId);
    if (file === undefined) return [];
    let raw: string;
    try {
      raw = readFileSync(file.wireFile, "utf8");
    } catch {
      return [];
    }
    const events: DelegationEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const text = extractAssistantText(line);
      if (text !== null) events.push({ type: "output", text });
    }
    return events.slice(page.offset, page.offset + page.limit);
  }

  /** 一次扫到底：会话目录只有两层，量级是几十到几百，不值得做增量。 */
  private scan(): KimiSessionFile[] {
    const found: KimiSessionFile[] = [];
    for (const workspaceDir of safeDirs(this.deps.sessionsDir)) {
      for (const sessionDir of safeDirs(workspaceDir)) {
        const stateFile = join(sessionDir, "state.json");
        let raw: string;
        try {
          raw = readFileSync(stateFile, "utf8");
        } catch {
          continue;
        }
        let state: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed !== "object" || parsed === null) continue;
          state = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        const id = typeof state["id"] === "string" ? state["id"] : null;
        if (id === null) continue;
        // 归档会话不列出来：它们已经不在 Kimi 的界面上。
        if (state["archived"] === true) continue;
        const updatedAt = typeof state["updatedAt"] === "number" ? state["updatedAt"] : 0;
        found.push({
          id,
          title: typeof state["title"] === "string" && state["title"].trim() !== "" ? state["title"] : "(无标题)",
          updatedAt,
          wireFile: join(sessionDir, "agents", "main", "wire.jsonl"),
        });
      }
    }
    return found;
  }
}

/** 只取 assistant 的正文：用户自己的话和思考过程不属于"结果"。 */
function extractAssistantText(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === "" || !trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "agent.message.appended") return null;
  const outer = asRecord(record["message"]);
  const message = asRecord(outer["message"]);
  if (message["role"] !== "assistant") return null;
  const content = message["content"];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    const item = asRecord(part);
    if (item["type"] === "text" && typeof item["text"] === "string" && item["text"] !== "") {
      parts.push(item["text"]);
    }
  }
  return parts.length === 0 ? null : parts.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function safeDirs(dir: string): string[] {
  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((full) => {
        try {
          return statSync(full).isDirectory();
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}
