/**
 * 结构化输出契约与 MCP OAuth 授权流测试。
 *
 * 验证 MCP 授权与模型结构化输出的边界行为：
 * 结构化输出必须是供应商原生能力 + 严格解析；OAuth 必须带 PKCE，且服务器没元数据时明确拒绝。
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchemaFormat, parseStructured } from "../../src/host/models/structured.js";
import {
  OAUTH_CLIENT_ID,
  OAUTH_REDIRECT,
  buildAuthorizationUrl,
} from "../../src/host/mcp/oauth.js";

const Answer = z.object({ verdict: z.enum(["ok", "no"]), reasons: z.array(z.string()) });

function fakeFetch(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("Structured Output and Schema Constraints", () => {
  it("uses provider native structured output format rather than prompting", () => {
    const format = jsonSchemaFormat("answer", { type: "object" });
    expect(format.kind).toBe("json-schema");
    if (format.kind === "json-schema") {
      expect(format.name).toBe("answer");
      expect(format.schema).toEqual({ type: "object" });
    }
  });

  it("passes valid pure JSON output directly", () => {
    const parsed = parseStructured('{"verdict":"ok","reasons":["够了"]}', Answer);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.reasons).toEqual(["够了"]);
  });

  it("tolerates markdown json fences and surrounding text", () => {
    const fenced = parseStructured('好的，结果如下：\n```json\n{"verdict":"no","reasons":[]}\n```\n完事', Answer);
    expect(fenced.ok).toBe(true);
    if (fenced.ok) expect(fenced.value.verdict).toBe("no");
  });

  it("errors on invalid schema specifying which property failed", () => {
    const parsed = parseStructured('{"verdict":"maybe"}', Answer);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("不符合约定结构");
      expect(parsed.message).toContain("verdict");
      expect(parsed.message).toContain("不符合约定结构");
    }
  });

  it("provides actionable error hints for empty output and invalid JSON", () => {
    const empty = parseStructured("   ", Answer);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toContain("没有返回任何内容");

    const broken = parseStructured("{verdict: ok}", Answer);
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.message).toContain("不是合法 JSON");
  });
});

describe("MCP OAuth Authorization Flow", () => {
  it("generates PKCE authorization URL from MCP server metadata", async () => {
    const authorization = await buildAuthorizationUrl(
      "https://mcp.example.com/sse",
      fakeFetch({
        authorization_endpoint: "https://mcp.example.com/authorize",
        token_endpoint: "https://mcp.example.com/token",
      }),
    );
    const url = new URL(authorization.url);
    expect(url.origin + url.pathname).toBe("https://mcp.example.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(OAUTH_REDIRECT);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(authorization.state);

    // PKCE 的挑战值必须是 verifier 的 S256，客户端不能自己编一个。
    const expected = createHash("sha256").update(authorization.verifier).digest("base64url");
    expect(url.searchParams.get("code_challenge")).toBe(expected);
    expect(authorization.verifier.length).toBeGreaterThanOrEqual(43);
    expect(authorization.state).not.toBe(authorization.verifier);
  });

  it("rejects servers lacking OAuth metadata without guessing endpoints", async () => {
    await expect(
      buildAuthorizationUrl("https://no-metadata.example.com", fakeFetch({}, 404)),
    ).rejects.toThrow(/没有提供 OAuth 授权元数据/);
    await expect(
      buildAuthorizationUrl("https://no-metadata.example.com", fakeFetch({})),
    ).rejects.toThrow(/改用 stdio 方式接入/);
  });

  it("provides actionable message when target is not a valid URL", async () => {
    await expect(buildAuthorizationUrl("不是网址")).rejects.toThrow(/不是合法 URL/);
  });
});
