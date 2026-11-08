/**
 * 字段清单（shape）守卫。遵循架构设计规范。
 *
 * 存字段字面量而不是哈希：不匹配时能直接看出哪个事件多了或少了哪个字段。
 */

import { EVENT, eventFields, META_FIELDS, type EventType } from "./events.js";

/** `type:f1,f2;type:f1,f2` —— 顺序由 schema 声明顺序固定。 */
export function shapeOf(): string {
  return Object.entries(EVENT)
    .map(([type, schema]) => `${type}:${Object.keys(schema.shape).join(",")}`)
    .join(";");
}

/** 当前代码里某类事件应有的字段名（用于给出"谁多了谁少了"的提示）。 */
export function expectedFields(type: EventType): string[] {
  return eventFields(type);
}

/** 首行 `fields` 应当等于它。 */
export function headerFields(): string {
  return shapeOf();
}

export { META_FIELDS };

/**
 * 比较两份 shape，给出可执行的差异描述。
 * 返回 null 表示完全一致。
 */
export function diffShape(recorded: string, current: string): string | null {
  if (recorded === current) return null;
  // 只新增了事件类型、已有类型的字段一个没动：旧日志照样能按原样解析，放行。
  // 删类型、改字段仍然拒绝——那会让旧日志被误读。
  const recordedParts = recorded.split(";");
  const currentParts = new Set(current.split(";"));
  if (recordedParts.every((part) => currentParts.has(part))) return null;
  const split = (s: string): Map<string, string[]> => {
    const map = new Map<string, string[]>();
    for (const part of s.split(";")) {
      const at = part.indexOf(":");
      if (at < 0) continue;
      map.set(part.slice(0, at), part.slice(at + 1).split(",").filter((f) => f !== ""));
    }
    return map;
  };
  const was = split(recorded);
  const now = split(current);
  const lines: string[] = [];
  for (const [type, fields] of now) {
    const before = was.get(type);
    if (before === undefined) {
      lines.push(`新增事件类型 ${type}`);
      continue;
    }
    const added = fields.filter((f) => !before.includes(f));
    const removed = before.filter((f) => !fields.includes(f));
    if (added.length > 0 || removed.length > 0) {
      lines.push(`${type}: 多了 [${added.join(",")}] 少了 [${removed.join(",")}]`);
    }
  }
  for (const type of was.keys()) {
    if (!now.has(type)) lines.push(`删除事件类型 ${type}`);
  }
  return lines.length > 0 ? lines.join("; ") : `字段顺序变化`;
}
