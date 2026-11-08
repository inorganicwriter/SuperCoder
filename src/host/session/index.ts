/**
 * `index.json`。遵循架构设计规范。
 *
 * 派生索引结构，仅用于加速会话检索与列表渲染：
 * - 字段守卫失败 → 静默删除并重建（约 20ms）
 * - 写入时机：`turn/end` 时整体重写，tmp + rename 保证原子
 * - `anchors` 是 seq → 行号的稀疏锚点，每 50 条一个
 */

import { existsSync, rmSync } from "node:fs";
import { z } from "zod";
import { SessionStatusSchema, type LogHeader } from "../../shared/session/events.js";
import { SessionCountsSchema, type DerivedView } from "../../shared/session/derive.js";
import { shapeOf } from "../../shared/session/shape.js";
import { readJsonIfPresent, writeJsonAtomic } from "../boot/atomic.js";

export const SessionIndexSchema = z.object({
  fields: z.string(),
  sessionId: z.string(),
  header: z.object({
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    workspace: z.string(),
    language: z.string(),
    status: SessionStatusSchema,
  }),
  lastSeq: z.number().int().nonnegative(),
  anchors: z.array(z.number().int().nonnegative()),
  counts: SessionCountsSchema,
});
export type SessionIndex = z.infer<typeof SessionIndexSchema>;

export interface BuildIndexInput {
  readonly sessionId: string;
  readonly header: LogHeader;
  readonly view: DerivedView;
  readonly anchors: readonly number[];
}

/** `updatedAt` 不在首行里：它等于最后一条事件的时间，由投影给出。 */
export function buildIndex(input: BuildIndexInput): SessionIndex {
  return {
    fields: shapeOf(),
    sessionId: input.sessionId,
    header: {
      title: input.header.meta.title,
      createdAt: input.header.meta.createdAt,
      updatedAt: lastUpdatedAt(input.view, input.header),
      workspace: input.header.meta.workspace,
      language: input.header.meta.language,
      status: input.view.status,
    },
    lastSeq: input.view.lastSeq,
    anchors: [...input.anchors],
    counts: input.view.counts,
  };
}

function lastUpdatedAt(view: DerivedView, header: LogHeader): string {
  const lastMessage = view.messages[view.messages.length - 1];
  const candidates = [header.meta.createdAt, lastMessage?.at ?? ""];
  for (const task of view.tasks) candidates.push(task.updatedAt);
  return candidates.filter((value) => value !== "").sort().pop() ?? header.meta.createdAt;
}

export function writeSessionIndex(file: string, index: SessionIndex): void {
  writeJsonAtomic(file, index);
}

/**
 * 读索引。任何守卫失败（不存在、JSON 坏、字段不符、fields 过时）都返回 null，
 * 调用方据此静默重建。
 */
export function readSessionIndex(file: string, sessionId: string): SessionIndex | null {
  const raw = readJsonIfPresent(file);
  if (raw === null) return null;
  const parsed = SessionIndexSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.fields !== shapeOf()) return null;
  if (parsed.data.sessionId !== sessionId) return null;
  return parsed.data;
}

export function deleteSessionIndex(file: string): void {
  if (existsSync(file)) rmSync(file, { force: true });
}

/** 从锚点估算某 seq 的行号；与 reader.lineOfSeq 同构，供索引重建复用。 */
export function anchorsFromSeqs(seqToLine: ReadonlyMap<number, number>): number[] {
  const anchors: number[] = [];
  for (const [seq, line] of seqToLine) {
    if (seq % 50 === 0) anchors[Math.floor(seq / 50) - 1] = line;
  }
  return anchors;
}
