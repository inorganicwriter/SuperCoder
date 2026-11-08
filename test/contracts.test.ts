import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shapeOf } from "../src/shared/session/shape.js";
import { EVENT_TYPES } from "../src/shared/session/events.js";
import { METHOD_NAMES } from "../src/shared/protocol/methods.js";
import { BUILTIN_TOOL_NAMES } from "../src/shared/domain/builtin-tools.js";

describe("Core Protocol and Contract Specifications", () => {
  it("maintains consistent RPC method names and count", () => {
    expect(METHOD_NAMES).toHaveLength(39);
    expect(new Set(METHOD_NAMES).size).toBe(39);
  });

  it("defines complete and immutable builtin tools collection", () => {
    expect([...BUILTIN_TOOL_NAMES]).toEqual([
      "list_available_agents",
      "dispatch_task",
      "query_task_status",
      "list_agent_sessions",
      "read_agent_session",
      "manage_context_capsule",
      "run_workspace_verification",
      "ask_user_decision",
    ]);
  });

  it("maintains complete and stable session event schemas", () => {
    expect(EVENT_TYPES).toHaveLength(23);
    const shape = shapeOf();
    expect(shape.startsWith("user/message:seq,at,text,attachments")).toBe(true);
    expect(shape).toContain("session/repaired:seq,at,truncatedBytes");
  });

  it("configures comprehensive and secure CSP for renderer process", () => {
    const html = readFileSync(join(process.cwd(), "src", "client", "index.html"), "utf8");
    const match = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
    expect(match).not.toBeNull();
    const policy = (match?.[1] ?? "").split(";").map((part) => part.trim());
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy).toContain("connect-src 'self' ws://127.0.0.1:*");
    expect(policy).toContain("img-src 'self' data:");
    expect(policy).toContain("font-src 'self'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    // 任何一条放行 eval / 远端脚本都会让脚本注入重新可用。
    expect(html).not.toContain("unsafe-eval");
    expect(policy).not.toContain("script-src 'self' https:");
  });
});
