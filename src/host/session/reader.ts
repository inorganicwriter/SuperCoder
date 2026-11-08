/**
 * 日志读取与崩溃修复。遵循架构设计规范。
 *
 * 启动时的固定三步：
 * 1. 校验首行 header 结构与 fields 字段，不匹配则拒绝加载以避免数据损坏
 * 2. 定位最后一个 `\n`，把之后的半行物理截断
 * 3. 交回 `truncatedBytes`，由上层追加一条 `session/repaired`
 *
 * 任何一行解析失败 = 整体拒绝加载，并把行号写进错误信息。
 */

import { closeSync, existsSync, ftruncateSync, openSync, readFileSync } from "node:fs";
import {
  LogHeaderSchema,
  parseSessionEvent,
  type EventType,
  type LogHeader,
  type SessionEvent,
} from "../../shared/session/events.js";
import { diffShape, shapeOf } from "../../shared/session/shape.js";

export type LoadErrorCode = "missing" | "empty" | "bad_header" | "shape_mismatch" | "corrupt";

export interface LoadError {
  readonly code: LoadErrorCode;
  /** 给人看的原因。 */
  readonly message: string;
  /** 下一步可执行的动作。 */
  readonly hint: string;
  readonly line?: number;
}

export interface LoadedLog {
  readonly header: LogHeader;
  readonly events: SessionEvent[];
  /** 被截断的字节数；0 表示文件本来就是完整的。 */
  readonly truncatedBytes: number;
  /** anchors[k] = seq 为 (k+1)*50 的那一行行号（行号从 1 开始，首行为 1）。 */
  readonly anchors: number[];
}

export type LoadResult =
  | { readonly ok: true; readonly value: LoadedLog }
  | { readonly ok: false; readonly error: LoadError };

export type HeaderResult =
  | { readonly ok: true; readonly value: LogHeader }
  | { readonly ok: false; readonly error: LoadError };

export interface LoadOptions {
  /** true 时真的执行物理截断（启动路径）；false 只报告（诊断路径）。 */
  readonly repair?: boolean;
}

export const ANCHOR_EVERY = 50;

const HINT_REPAIR =
  "点“重建”（session.rebuild）重算索引；若仍然失败，先备份 sessions/<id>/log.jsonl 再升级。";
const HINT_TRUNCATE =
  "先备份该会话目录；损坏行之前的历史仍然完整，删除该行即可继续。";

export function loadError(
  code: LoadErrorCode,
  message: string,
  hint: string,
  line?: number,
): LoadError {
  return line === undefined ? { code, message, hint } : { code, message, hint, line };
}

function reject(
  code: LoadErrorCode,
  message: string,
  hint: string,
  line?: number,
): { ok: false; error: LoadError } {
  return { ok: false, error: loadError(code, message, hint, line) };
}

/** 只读首行：列出会话时用，不解析全部事件。 */
export function readHeader(file: string): HeaderResult {
  if (!existsSync(file)) {
    return reject("missing", `找不到日志 ${file}`, "重新创建会话。");
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return reject("corrupt", `读取失败：${String(error)}`, "检查文件权限后重试。");
  }
  const at = text.indexOf("\n");
  const first = at < 0 ? text : text.slice(0, at);
  if (first.trim() === "") {
    return reject("empty", "日志首行为空，缺少头部。", HINT_REPAIR, 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(first);
  } catch (error) {
    return reject("bad_header", `首行不是合法 JSON：${String(error)}`, HINT_REPAIR, 1);
  }
  const header = LogHeaderSchema.safeParse(parsed);
  if (!header.success) {
    return reject(
      "bad_header",
      `首行缺少头部字段：${header.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      HINT_REPAIR,
      1,
    );
  }
  const drift = diffShape(header.data.fields, shapeOf());
  if (drift !== null) {
    return reject("shape_mismatch", `数据结构已变更：${drift}`, HINT_REPAIR, 1);
  }
  return { ok: true, value: header.data };
}

/**
 * 全量加载。`repair` 为 true 时按  第 2 步物理截断半行。
 */
export function loadLog(file: string, options: LoadOptions = {}): LoadResult {
  const repair = options.repair === true;
  if (!existsSync(file)) {
    return reject("missing", `找不到日志 ${file}`, "重新创建会话。");
  }
  let buffer: Buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    return reject("corrupt", `读取失败：${String(error)}`, "检查文件权限后重试。");
  }
  if (buffer.length === 0) {
    return reject("empty", "日志文件是空的（0 字节），没有头部。", HINT_REPAIR);
  }

  // 第 2 步：先定位最后一个换行，决定要丢弃多少字节。
  let end = buffer.length;
  let truncatedBytes = 0;
  const lastNewline = buffer.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    // 整个文件连一个换行都没有：连头部都不完整。
    if (repair) truncateTo(file, 0);
    return reject("empty", "日志里没有任何完整行（连头部都没写完）。", HINT_REPAIR);
  }
  if (lastNewline + 1 < buffer.length) {
    truncatedBytes = buffer.length - (lastNewline + 1);
    end = lastNewline + 1;
    if (repair) truncateTo(file, end);
  }

  const text = buffer.subarray(0, end).toString("utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const firstLine = lines[0];
  if (firstLine === undefined || firstLine.trim() === "") {
    return reject("empty", "日志首行为空，缺少头部。", HINT_REPAIR, 1);
  }
  let headerRaw: unknown;
  try {
    headerRaw = JSON.parse(firstLine);
  } catch (error) {
    return reject("bad_header", `首行不是合法 JSON：${String(error)}`, HINT_REPAIR, 1);
  }
  const header = LogHeaderSchema.safeParse(headerRaw);
  if (!header.success) {
    return reject(
      "bad_header",
      `首行缺少头部字段：${header.error.issues.map((i) => `${i.path.join(".")}`).join(", ")}`,
      HINT_REPAIR,
      1,
    );
  }
  const drift = diffShape(header.data.fields, shapeOf());
  if (drift !== null) {
    return reject("shape_mismatch", `数据结构已变更：${drift}`, HINT_REPAIR, 1);
  }

  const events: SessionEvent[] = [];
  const anchors: number[] = [];
  let expectedSeq = 1;
  for (let index = 1; index < lines.length; index += 1) {
    const raw = lines[index];
    if (raw === undefined) continue;
    const lineNo = index + 1;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      return reject("corrupt", `第 ${lineNo} 行不是合法 JSON：${String(error)}`, HINT_TRUNCATE, lineNo);
    }
    const parsed = parseSessionEvent(json);
    if (!parsed.ok) {
      return reject("corrupt", `第 ${lineNo} 行不符合事件形状：${parsed.issue}`, HINT_TRUNCATE, lineNo);
    }
    if (parsed.value.seq !== expectedSeq) {
      return reject(
        "corrupt",
        `第 ${lineNo} 行的 seq 是 ${parsed.value.seq}，应为 ${expectedSeq}（单点分配后必须连续递增）`,
        HINT_TRUNCATE,
        lineNo,
      );
    }
    expectedSeq += 1;
    events.push(parsed.value);
    if (parsed.value.seq % ANCHOR_EVERY === 0) {
      anchors[Math.floor(parsed.value.seq / ANCHOR_EVERY) - 1] = lineNo;
    }
  }

  return { ok: true, value: { header: header.data, events, truncatedBytes, anchors } };
}

function truncateTo(file: string, size: number): void {
  const fd = openSync(file, "r+");
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

/** 按 (seq, 行号) 锚点估算某 seq 所在行，用于增量补发时跳过前段。 */
export function lineOfSeq(anchors: readonly number[], seq: number): number {
  const bucket = Math.floor(seq / ANCHOR_EVERY) - 1;
  for (let i = Math.min(bucket, anchors.length - 1); i >= 0; i -= 1) {
    const line = anchors[i];
    if (line !== undefined && line > 0) return line;
  }
  return 2;
}

/** 便于诊断：某类事件出现过多少次。 */
export function countByType(events: readonly SessionEvent[]): Partial<Record<EventType, number>> {
  const counts: Partial<Record<EventType, number>> = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
}
