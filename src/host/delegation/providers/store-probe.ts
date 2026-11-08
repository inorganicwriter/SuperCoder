/**
 * 只读私有存储探测。
 *
 * 这一级永远不写、永远不任务分派：只把执行者自己留下的历史读出来给人看。
 * 因此 `fragility: "reverse-engineered"`，界面必须显示"兼容模式"角标。
 *
 * 支持两种私有存储：
 * - JSONL 会话文件（Codex 的 rollout-*.jsonl 目录布局）
 * - SQLite 库（通过 sql.js 以只读内存副本形式打开，避免持有或修改原文件）
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DelegationEvent } from "../../../shared/domain/delegation.js";
import type {
  ProviderPage,
  ProviderSessionSummary,
  StoreProbe,
} from "../../../shared/domain/provider.js";
import { readTextIfPresent } from "../../boot/atomic.js";
import { messageOf } from "../../boot/failure.js";

export interface StoreProbeDeps {
  /** providerId → 候选根目录（可用 `~` 开头）。 */
  readonly roots: Readonly<Record<string, readonly string[]>>;
  readonly homeDir?: string;
}

export class JsonlStoreProbe implements StoreProbe {
  constructor(
    readonly providerId: string,
    private readonly options: StoreProbeDeps,
  ) {}

  async locate(_workspace: string): Promise<string | null> {
    for (const candidate of this.roots()) {
      const expanded = expandHome(candidate, this.options.homeDir);
      if (existsDir(expanded)) return expanded;
    }
    return null;
  }

  private roots(): readonly string[] {
    return this.options.roots[this.providerId] ?? [];
  }

  async listSessions(workspace: string, page: ProviderPage): Promise<ProviderSessionSummary[]> {
    const root = await this.locate(workspace);
    if (root === null) return [];
    const files = collectFiles(root, 5).sort((left, right) => right.mtimeMs - left.mtimeMs);
    return files.slice(page.offset, page.offset + page.limit).map((file) => ({
      sessionId: file.sessionId,
      title: summarizeTitle(file.path, workspace),
      updatedAt: new Date(file.mtimeMs).toISOString(),
    }));
  }

  async readSession(sessionId: string, page: ProviderPage): Promise<DelegationEvent[]> {
    const root = await this.locate("");
    if (root === null) return [];
    const file = collectFiles(root, 5).find((candidate) => candidate.sessionId === sessionId);
    if (file === undefined) return [];
    const raw = readTextIfPresent(file.path);
    if (raw === null) return [];
    const events: DelegationEvent[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const text = extractText(line);
      if (text !== null) events.push({ type: "output", text });
    }
    return events.slice(page.offset, page.offset + page.limit);
  }
}

export interface SqliteStoreProbeOptions {
  readonly databaseFile: string;
}

/** 用 sql.js 打开只读副本：先把字节读进内存，原库文件全程只读。 */
export async function readSqliteSessions(
  databaseFile: string,
): Promise<ProviderSessionSummary[]> {
  let bytes: Uint8Array;
  try {
    const handle = await open(databaseFile, "r");
    try {
      const stat = await handle.stat();
      const buffer = Buffer.alloc(Number(stat.size));
      await handle.read(buffer, 0, buffer.length, 0);
      bytes = new Uint8Array(buffer);
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new Error(`读取本地数据库失败：${messageOf(error)}。`);
  }

  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database(bytes);
  try {
    const tables = db
      .exec("SELECT name FROM sqlite_master WHERE type='table'")
      .flatMap((result) => result.values.map((row) => String(row[0] ?? "")))
      .filter((name) => name !== "");
    for (const table of tables) {
      const columns = columnNames(db, table);
      if (!columns.includes("id")) continue;
      const titleColumn = ["title", "summary", "name", "goal"].find((name) => columns.includes(name));
      const timeColumn = ["updated_at", "updatedAt", "mtime", "created_at"].find((name) =>
        columns.includes(name),
      );
      const rows = db.exec(
        `SELECT * FROM "${table}" LIMIT 200`,
      );
      const result: ProviderSessionSummary[] = [];
      for (const block of rows) {
        const index = new Map(block.columns.map((column, at) => [column, at]));
        for (const row of block.values) {
          const id = String(row[index.get("id") ?? 0] ?? "");
          if (id === "") continue;
          const title =
            titleColumn === undefined ? "(无标题)" : String(row[index.get(titleColumn) ?? 0] ?? "(无标题)");
          const updatedAt = timeColumn === undefined ? new Date(0).toISOString() : String(row[index.get(timeColumn) ?? 0] ?? "");
          result.push({
            sessionId: id,
            title,
            updatedAt: updatedAt === "" ? new Date(0).toISOString() : updatedAt,
          });
        }
      }
      if (result.length > 0) return result;
    }
    return [];
  } finally {
    db.close();
  }
}

function columnNames(db: { exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }> }, table: string): string[] {
  try {
    const rows = db.exec(`PRAGMA table_info("${table}")`);
    const block = rows[0];
    if (block === undefined) return [];
    const nameAt = block.columns.indexOf("name");
    return block.values.map((row) => String(row[nameAt] ?? ""));
  } catch {
    return [];
  }
}

interface FoundFile {
  readonly path: string;
  readonly sessionId: string;
  readonly mtimeMs: number;
}

function collectFiles(root: string, maxDepth: number): FoundFile[] {
  const found: FoundFile[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!entry.endsWith(".jsonl")) continue;
      found.push({
        path: full,
        sessionId: sessionIdOf(entry, full),
        mtimeMs: stat.mtimeMs,
      });
    }
  };
  walk(root, 0);
  return found;
}

function sessionIdOf(fileName: string, fullPath: string): string {
  const base = fileName.replace(/\.jsonl$/, "");
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(base);
  if (match !== null && match[1] !== undefined) return match[1];
  const trimmed = base.replace(/^rollout-/, "");
  return trimmed === "" ? fullPath : trimmed;
}

function summarizeTitle(path: string, workspace: string): string {
  try {
    const raw = readFileSync(path, "utf8");
    const firstLine = raw.slice(0, raw.indexOf("\n") === -1 ? raw.length : raw.indexOf("\n"));
    const text = extractText(firstLine);
    if (text !== null) return text.slice(0, 80);
  } catch {
    /* 读不到就用文件名 */
  }
  const base = path.split(/[\\/]/).pop() ?? path;
  return workspace === "" ? base : `${base}（${workspace}）`;
}

function extractText(line: string): string | null {
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
  const payload =
    typeof record["payload"] === "object" && record["payload"] !== null
      ? (record["payload"] as Record<string, unknown>)
      : record;
  for (const key of ["text", "message", "content", "summary"]) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return null;
}

function expandHome(path: string, homeDir = homedir()): string {
  return path.startsWith("~") ? join(homeDir, path.slice(1)) : path;
}

function existsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
