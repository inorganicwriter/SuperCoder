/**
 * 性能预算指标基线定义。
 *
 * 集中管理各环节耗时与资源预算，供基准测试 (`bench/index.ts`) 与性能断言统一引用。
 */

/** 第 1 项：冷启动到可交互。 */
export const COLD_START_MS = 2000;

/** 第 2 项：5000 文件快照。 */
export const SNAPSHOT_MS = 300;

/** 第 3 项：日志写入 p99。 */
export const LOG_P99_MS = 5;

/** 第 4 项：会话打开（1 万条事件）。 */
export const SESSION_OPEN_MS = 150;

/** 第 5 项：索引重建（单会话 1 万条）。 */
export const INDEX_REBUILD_MS = 200;

/** 第 6 项：空闲网络请求（条）。 */
export const IDLE_REQUESTS = 0;

/** 第 7 项：界面派生（10k 事件后单批新增）。一帧的预算。 */
export const UI_DERIVATION_MS = 16;

/**
 * 表格"目标"列的文字：由常量生成，避免文案与判定各写一份。
 *
 * `unit` 用 `"ms"` 或 `"count"`，与 `Measurement.unit` 同一套词。
 */
export function budgetTarget(budget: number, unit: "ms" | "count"): string {
  return unit === "ms" ? `< ${String(budget)}ms` : String(budget);
}
