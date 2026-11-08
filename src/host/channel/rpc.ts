/**
 * RPC 分发。遵循架构设计规范。
 *
 * 校验点（C5）：入参按 `METHODS[name].params` 校验，回包按 `METHODS[name].result` 校验。
 * 两边都不信任调用方——包括我们自己的 client。
 */

import {
  isMethodName,
  METHODS,
  type MethodName,
  type MethodParams,
  type MethodResult,
} from "../../shared/protocol/methods.js";
import {
  resultErr,
  resultOk,
  type RpcRequest,
  type RpcResponse,
} from "../../shared/protocol/rpc.js";
import { isRpcFailure, messageOf } from "../boot/failure.js";
import type { Logger } from "../boot/logger.js";

export type RpcHandler<M extends MethodName = MethodName> = (
  params: MethodParams<M>,
) => Promise<MethodResult<M>> | MethodResult<M>;

export class RpcRouter {
  private readonly handlers = new Map<MethodName, RpcHandler<never>>();

  constructor(private readonly logger: Logger) {}

  register<M extends MethodName>(name: M, handler: RpcHandler<M>): void {
    if (this.handlers.has(name)) throw new Error(`RPC 方法重复注册：${name}`);
    this.handlers.set(name, handler as RpcHandler<never>);
  }

  has(name: string): boolean {
    return isMethodName(name) && this.handlers.has(name);
  }

  methods(): MethodName[] {
    return [...this.handlers.keys()];
  }

  async dispatch(request: RpcRequest): Promise<RpcResponse> {
    if (!isMethodName(request.method)) {
      return resultErr(
        request.rpcId,
        "invalid_params",
        `未识别的 RPC 方法：${request.method}。`,
      );
    }
    const name = request.method;
    const handler = this.handlers.get(name);
    if (!handler) {
      return resultErr(
        request.rpcId,
        "invalid_params",
        `方法 ${name} 尚未实现。`,
      );
    }
    const params = METHODS[name].params.safeParse(request.params);
    if (!params.success) {
      const detail = params.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return resultErr(request.rpcId, "invalid_params", `${name} 参数不符：${detail}`);
    }
    try {
      const result = await handler(params.data as never);
      const checked = METHODS[name].result.safeParse(result);
      if (!checked.success) {
        this.logger.error(
          { method: name, issues: checked.error.issues },
          "处理器返回值不符合契约",
        );
        return resultErr(
          request.rpcId,
          "internal",
          `${name} 返回值不符合契约定义。`,
        );
      }
      return resultOk(request.rpcId, checked.data);
    } catch (error) {
      if (isRpcFailure(error)) {
        return resultErr(request.rpcId, error.code, error.message);
      }
      this.logger.error({ method: name, error: messageOf(error) }, "RPC 处理器抛出未预期错误");
      return resultErr(
        request.rpcId,
        "internal",
        `${name} 执行失败：${messageOf(error)}。`,
      );
    }
  }
}

/** 断言方法表完整覆盖；只在启动时跑一次。 */
export function assertFullCoverage(router: RpcRouter): void {
  const missing = (Object.keys(METHODS) as MethodName[]).filter((name) => !router.has(name));
  if (missing.length > 0) {
    throw new Error(`以下 RPC 方法未注册：${missing.join(", ")}`);
  }
}
