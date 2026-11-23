import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { AcpProvider } from "../../src/host/delegation/providers/acp.js";
import { spawnChild } from "../../src/host/boot/exec.js";
import { createStdioTransport } from "../../src/host/delegation/transport.js";
import type { DelegationRequest } from "../../src/shared/domain/delegation.js";

const script = fileURLToPath(new URL("../fixtures/providers/acp-auth-error.cjs", import.meta.url));

const request = (): DelegationRequest => ({
  childId: "one",
  agentId: "deepseek-harness",
  workspace: process.cwd(),
  goal: "test",
  instruction: "",
  mode: "read-only",
  signal: new AbortController().signal,
  onEvent: () => {},
});

const provider = (mode: string): AcpProvider =>
  new AcpProvider({
    providerId: "deepseek-harness",
    drainMs: 0,
    createTransport: (cwd) => createStdioTransport(spawnChild(process.execPath, [script, mode], { cwd })),
  });

describe("ACP 鉴权失败定性", () => {
  it("没有任何输出、也没有工具调用时按失败处理，并给出 SuperCoder 这一侧的下一步", async () => {
    const result = await provider("auth").delegate(request());
    expect(result).toMatchObject({ status: "failed", diagnostic: { stage: "turn", category: "auth" } });
    const detail = result.status === "failed" ? (result.diagnostic.detail ?? "") : "";
    expect(detail).toContain("deepseek-official");
    expect(detail).toContain("｜下一步：");
    expect(detail.length).toBeLessThanOrEqual(200);
  });

  it("已经收到过模型输出时仍然是未知态，因为可能已经动过工作区", async () => {
    expect(await provider("auth-after-output").delegate(request())).toMatchObject({ status: "unknown" });
  });

  it("已经发起过工具调用时仍然是未知态", async () => {
    expect(await provider("auth-after-tool").delegate(request())).toMatchObject({ status: "unknown" });
  });

  it("HTTP 401 同样按鉴权失败处理", async () => {
    expect(await provider("auth-401").delegate(request())).toMatchObject({ status: "failed", diagnostic: { category: "auth" } });
  });

  it("没有输出就 502 时按服务失败处理，而不是结果未知", async () => {
    expect(await provider("service-502").delegate(request())).toMatchObject({ status: "failed", diagnostic: { stage: "turn", category: "service" } });
  });
});
