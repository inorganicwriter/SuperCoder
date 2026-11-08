/**
 * Result<T, E>：宿主内部的显式失败传递。
 *
 * 用在"调用方必须处理失败"的路径上：模型调用、工具执行、磁盘写入。
 * 抛异常留给编程错误（不该发生的事），可预期的失败一律走 Result。
 */

export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(
  result: Result<T, E>,
): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
