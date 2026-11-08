/**
 * RpcFailure 测试用例。
 */

import { describe, expect, it } from "vitest";
import { isRpcFailure, RpcFailure } from "../../src/host/boot/failure.js";
import { ERROR_HINTS, ErrorCodeSchema } from "../../src/shared/protocol/errors.js";

describe("RpcFailure.of", () => {
  it("uses default hint for error code when callsite provides no details", () => {
    const failure = RpcFailure.of("storage_failed");
    expect(failure.code).toBe("storage_failed");
    expect(failure.message).toBe(ERROR_HINTS.storage_failed);
  });

  it("uses custom detail when provided by callsite", () => {
    const detail = "磁盘空间不足，写入中断";
    const failure = RpcFailure.of("storage_failed", detail);
    expect(failure.message).toBe(detail);
  });

  it("ensures every error code has a valid non-empty default hint", () => {
    for (const code of ErrorCodeSchema.options) {
      const failure = RpcFailure.of(code);
      expect(failure.code).toBe(code);
      expect(failure.message).toBe(ERROR_HINTS[code]);
      expect(failure.message.length).toBeGreaterThan(0);
    }
  });

  it("fail() throws an instance of RpcFailure", () => {
    const error = (() => {
      try {
        throw RpcFailure.of("invalid_params", "消息内容不能为空。");
      } catch (reason) {
        return reason;
      }
    })();
    expect(isRpcFailure(error)).toBe(true);
    if (isRpcFailure(error)) {
      expect(error.message).toBe("消息内容不能为空。");
      expect(error.code).toBe("invalid_params");
    }
  });
});
