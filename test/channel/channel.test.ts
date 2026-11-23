/**
 * 存储与通道：握手认证与安全帧收发验证。
 */

import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeBackfillOverlapChannel, makeChannel } from "../helpers/channel.js";
import { callbackPage } from "../../src/host/account/google.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { SubscriptionHub } from "../../src/host/channel/events.js";
import { RpcRouter } from "../../src/host/channel/rpc.js";
import { startChannel } from "../../src/host/channel/server.js";
import { isTransientEvent } from "../../src/shared/session/events.js";
import {
  createToken,
  normalizeOrigin,
  tokensEqual,
  tokenFromUrl,
  verifyHandshake,
} from "../../src/host/channel/auth.js";

describe("Handshake Authentication", () => {
  const expectedToken = createToken();

  it("accepts connection only when origin, host, and token all pass validation", () => {
    expect(
      verifyHandshake({
        host: "127.0.0.1:1234",
        origin: "http://127.0.0.1:1234",
        token: expectedToken,
        expectedToken,
        port: 1234,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects invalid origin, mismatched host, or missing/invalid token", () => {
    const base = {
      host: "127.0.0.1:1234",
      origin: "http://127.0.0.1:1234",
      token: expectedToken,
      expectedToken,
      port: 1234,
    };
    expect(verifyHandshake({ ...base, origin: "http://evil.example:1234" }).ok).toBe(false);
    expect(verifyHandshake({ ...base, host: "evil.example:1234" }).ok).toBe(false);
    expect(verifyHandshake({ ...base, token: "x" }).ok).toBe(false);
    expect(verifyHandshake({ ...base, token: undefined }).ok).toBe(false);
    expect(verifyHandshake({ ...base, origin: undefined }).ok).toBe(false);
  });

  it("compares tokens in constant time with length short-circuit", () => {
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abcd")).toBe(false);
    expect(tokensEqual("", "")).toBe(true);
  });

  it("normalizes Origin by stripping scheme and trailing slash", () => {
    expect(normalizeOrigin("http://127.0.0.1:9/")).toBe("127.0.0.1:9");
    expect(normalizeOrigin("ws://127.0.0.1:9")).toBe("127.0.0.1:9");
    expect(tokenFromUrl("/ws?token=abc")).toBe("abc");
    expect(tokenFromUrl("/ws")).toBeUndefined();
  });

  it("validates credential format as 32-byte base64url string", () => {
    const token = createToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
  });
});

describe("Transport Channel", () => {
  it("handles RPC roundtrip, subscription replay, and cross-origin rejection", async () => {
    const channel = await makeChannel();
    try {
      const frames = await channel.roundTrip();
      expect(frames.result).toEqual({
        kind: "result",
        rpcId: "rpc-1",
        ok: true,
        result: { home: "/tmp/home", platform: "win32", dbPath: "/tmp/home/sessions" },
      });
      expect(frames.events.length).toBeGreaterThan(0);
      expect(frames.events[0]?.kind).toBe("events");

      // 异源：握手阶段就被关掉
      const rejected = await channel.attemptForeignOrigin();
      expect(rejected).toBe("rejected");
    } finally {
      await channel.close();
    }
  });

  it("deduplicates persisted events during overlap while delivering all transient events", async () => {
    const channel = await makeBackfillOverlapChannel();
    try {
      const events = await channel.collect();
      const persisted = events.filter((event) => !isTransientEvent(event.type));
      const transient = events.filter((event) => isTransientEvent(event.type));

      // 服务端已经按 backlog 的最大 seq 去了重叠，客户端不该再靠自己去重。
      expect(persisted.map((event) => event.seq)).toEqual([1, 2, 3]);
      expect(new Set(persisted.map((event) => event.seq)).size).toBe(persisted.length);
      // 瞬态借了 seq 3、又不在日志里：按 seq 过滤会把它误杀，所以必须原样发出去。
      expect(transient).toHaveLength(1);
      expect(transient[0]?.type).toBe("request/delta");
    } finally {
      await channel.close();
    }
  });

  it("enforces Bearer/Host checks on HTTP routes and escapes OAuth callback HTML", async () => {
    const logger = silentLogger();
    const router = new RpcRouter(logger);
    const hub = new SubscriptionHub(logger);
    const token = createToken();
    const root = mkdtempSync(join(tmpdir(), "sc-http-auth-"));
    writeFileSync(join(root, "note.txt"), "hello", "utf8");
    const running = await startChannel({
      router,
      hub,
      token,
      rendererDir: null,
      logger,
      workspaceRoot: (id) => (id === "ws1" ? root : ""),
      onSubscribe: async () => [],
    });
    try {
      const noAuth = await fetch(`${running.url}oauth/google/start?clientId=cid&challenge=abc`);
      expect(noAuth.status).toBe(401);

      const started = await fetch(`${running.url}oauth/google/start?clientId=cid&port=9999&challenge=abc`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(started.status).toBe(200);
      const startBody = (await started.json()) as { state: string; redirectUri: string };
      expect(startBody.redirectUri).toBe(`http://127.0.0.1:${running.port}/oauth/google/callback`);

      const unknownState = await fetch(`${running.url}oauth/google/callback?state=forged&code=1`);
      expect(unknownState.status).toBe(400);

      const filesOk = await fetch(`${running.url}files/list?workspaceId=ws1&path=`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(filesOk.status).toBe(200);

      const badHostStatus = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: running.port,
            path: "/files/list?workspaceId=ws1&path=",
            method: "GET",
            headers: {
              Host: "evil.example:1234",
              Authorization: `Bearer ${token}`,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(badHostStatus).toBe(403);

      const html = callbackPage({ ok: false, reason: '<script>alert("xss")</script>' });
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    } finally {
      await running.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
