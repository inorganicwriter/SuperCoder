/**
 * Per-Agent 本地网络代理网关测试：
 * - 鉴权拒绝（407）
 * - 域名白名单放行（含通配符 `*.example.test`）与拦截（403 + `onBlocked`）
 * - 黑名单覆盖白名单、离线模式拦截
 * - 上游 HTTP 代理转发与上游 SOCKS5（含 CONNECT 隧道）转发
 * - `testNetwork` 连通性探针
 */

import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AgentNetworkProxy, evaluateHostPolicy, stripIpv6Brackets } from "../../src/host/delegation/network-proxy.js";
import { AgentSandboxProfileSchema, matchHostPattern } from "../../src/shared/domain/sandbox.js";

const disposables: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (disposables.length > 0) {
    const close = disposables.pop()!;
    await close().catch(() => undefined);
  }
});

function startHttpEchoServer(label: string): Promise<{ port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${label}:${req.method}:${req.url}`);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as net.AddressInfo;
      disposables.push(
        () => new Promise<void>((done) => server.close(() => done())),
      );
      resolve({ port: addr.port });
    });
  });
}

function proxyHttpRequest(
  proxyUrl: string,
  targetUrl: string,
): Promise<{ status: number; body: string }> {
  const proxy = new URL(proxyUrl);
  const auth =
    proxy.username || proxy.password
      ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`
      : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        path: targetUrl,
        method: "GET",
        headers: {
          Host: new URL(targetUrl).host,
          ...(auth ? { "Proxy-Authorization": auth } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.once("error", reject);
    req.end();
  });
}

function proxyConnectTunnel(
  proxyUrl: string,
  authority: string,
): Promise<{ status: number; socket: net.Socket }> {
  const proxy = new URL(proxyUrl);
  const auth = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) }, () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${auth}\r\n\r\n`,
      );
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      socket.removeListener("data", onData);
      const statusLine = buf.subarray(0, idx).toString("latin1").split("\r\n")[0] ?? "";
      const match = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
      const rest = buf.subarray(idx + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve({ status: match ? Number(match[1]) : 0, socket });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

describe("AgentNetworkProxy", () => {
  it("matches exact and wildcard host patterns accurately", () => {
    expect(matchHostPattern("api.openai.com", "*.openai.com")).toBe(true);
    expect(matchHostPattern("openai.com", "*.openai.com")).toBe(true);
    expect(matchHostPattern("evilopenai.com", "*.openai.com")).toBe(false);
    expect(matchHostPattern("sub.a.test.", "sub.a.test")).toBe(true);
    expect(matchHostPattern("anything.local", "*")).toBe(true);
  });

  it("evaluates offline, denylist, and allowlist precedence consistently", () => {
    const offline = AgentSandboxProfileSchema.parse({ network: { mode: "offline" } }).network;
    expect(evaluateHostPolicy("127.0.0.1", offline).allowed).toBe(false);

    const mixed = AgentSandboxProfileSchema.parse({
      network: {
        mode: "direct",
        allowlist: ["*.trusted.test"],
        denylist: ["bad.trusted.test"],
      },
    }).network;
    expect(evaluateHostPolicy("api.trusted.test", mixed).allowed).toBe(true);
    expect(evaluateHostPolicy("bad.trusted.test", mixed).allowed).toBe(false);
    expect(evaluateHostPolicy("other.test", mixed).allowed).toBe(false);
  });

  it("rejects unauthenticated callers and enforces per-agent allowlist/offline policies", async () => {
    const target = await startHttpEchoServer("target");
    const proxy = new AgentNetworkProxy();
    await proxy.start();
    disposables.push(() => proxy.close());

    const unauth = await proxyHttpRequest(`http://127.0.0.1:${proxy.port}`, `http://127.0.0.1:${target.port}/ok`);
    expect(unauth.status).toBe(407);

    const blockedHosts: string[] = [];
    const allowedHosts: string[] = [];
    const allowedScope = proxy.registerScope({
      agentId: "agent-a",
      network: AgentSandboxProfileSchema.parse({
        network: { mode: "direct", allowlist: ["127.0.0.1"] },
      }).network,
      onBlocked: (host) => blockedHosts.push(host),
      onAllowed: (host) => allowedHosts.push(host),
    });

    const okRes = await proxyHttpRequest(allowedScope.proxyUrl, `http://127.0.0.1:${target.port}/ping`);
    expect(okRes.status).toBe(200);
    expect(okRes.body).toBe("target:GET:/ping");
    expect(allowedHosts).toEqual(["127.0.0.1"]);

    const tunnelOk = await proxyConnectTunnel(allowedScope.proxyUrl, `127.0.0.1:${target.port}`);
    expect(tunnelOk.status).toBe(200);
    tunnelOk.socket.destroy();
    expect(allowedHosts).toEqual(["127.0.0.1", "127.0.0.1"]);

    const deniedRes = await proxyHttpRequest(allowedScope.proxyUrl, "http://blocked.invalid/secret");
    expect(deniedRes.status).toBe(403);

    const colonScope = proxy.registerScope({
      agentId: "mcp:colon-test",
      network: AgentSandboxProfileSchema.parse({
        network: { mode: "direct", allowlist: ["127.0.0.1"] },
      }).network,
    });
    const colonRes = await proxyHttpRequest(colonScope.proxyUrl, `http://127.0.0.1:${target.port}/colon`);
    expect(colonRes.status).toBe(200);
    expect(colonRes.body).toBe("target:GET:/colon");
    colonScope.dispose();
    expect(blockedHosts).toEqual(["blocked.invalid"]);
    expect(allowedHosts).toEqual(["127.0.0.1", "127.0.0.1"]);
    allowedScope.dispose();

    const offlineScope = proxy.registerScope({
      agentId: "agent-offline",
      network: AgentSandboxProfileSchema.parse({ network: { mode: "offline" } }).network,
      onBlocked: (host) => blockedHosts.push(host),
    });
    const offlineConnect = await proxyConnectTunnel(offlineScope.proxyUrl, `127.0.0.1:${target.port}`);
    expect(offlineConnect.status).toBe(403);
    offlineConnect.socket.destroy();
    offlineScope.dispose();
  });

  it("routes requests differently through per-agent HTTP and SOCKS5 upstreams", async () => {
    const target = await startHttpEchoServer("real");

    // Mock HTTP upstream proxy that stamps a header / modifies body
    const httpUpstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`via-http-upstream:${req.url}`);
    });
    await new Promise<void>((resolve) => {
      httpUpstream.listen(0, "127.0.0.1", () => resolve());
    });
    disposables.push(() => new Promise<void>((done) => httpUpstream.close(() => done())));
    const httpUpPort = (httpUpstream.address() as net.AddressInfo).port;

    // Minimal SOCKS5 upstream server accepting no-auth CONNECT
    const socksServer = net.createServer((client) => {
      let stage = 0;
      let buf = Buffer.alloc(0);
      let remote: net.Socket | null = null;
      client.on("data", (chunk: Buffer) => {
        if (stage === 2 && remote !== null) {
          remote.write(chunk);
          return;
        }
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0 && buf.length >= 3) {
          buf = Buffer.alloc(0);
          stage = 1;
          client.write(Buffer.from([0x05, 0x00]));
          return;
        }
        if (stage === 1 && buf.length >= 7) {
          const atyp = buf[3]!;
          let host = "";
          let portOffset = 4;
          if (atyp === 0x01 && buf.length >= 10) {
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            portOffset = 8;
          } else if (atyp === 0x03) {
            const len = buf[4]!;
            if (buf.length < 5 + len + 2) return;
            host = buf.subarray(5, 5 + len).toString("utf8");
            portOffset = 5 + len;
          }
          const port = buf.readUInt16BE(portOffset);
          stage = 2;
          remote = net.connect(port, host, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            client.pipe(remote!);
            remote!.pipe(client);
          });
          remote.on("error", () => client.destroy());
        }
      });
      client.on("error", () => remote?.destroy());
    });
    await new Promise<void>((resolve) => {
      socksServer.listen(0, "127.0.0.1", () => resolve());
    });
    disposables.push(() => new Promise<void>((done) => socksServer.close(() => done())));
    const socksPort = (socksServer.address() as net.AddressInfo).port;

    const gateway = new AgentNetworkProxy();
    await gateway.start();
    disposables.push(() => gateway.close());

    const scopeHttp = gateway.registerScope({
      agentId: "agent-http",
      network: AgentSandboxProfileSchema.parse({
        network: { mode: "proxy", proxyUrl: `http://127.0.0.1:${httpUpPort}` },
      }).network,
    });
    const resHttp = await proxyHttpRequest(scopeHttp.proxyUrl, `http://example.invalid:${target.port}/hello`);
    expect(resHttp.status).toBe(200);
    expect(resHttp.body).toBe(`via-http-upstream:http://example.invalid:${target.port}/hello`);
    scopeHttp.dispose();

    const scopeSocks = gateway.registerScope({
      agentId: "agent-socks",
      network: AgentSandboxProfileSchema.parse({
        network: { mode: "proxy", proxyUrl: `socks5://127.0.0.1:${socksPort}` },
      }).network,
    });
    const tunnel = await proxyConnectTunnel(scopeSocks.proxyUrl, `127.0.0.1:${target.port}`);
    expect(tunnel.status).toBe(200);
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: target.port,
          path: "/via-socks",
          method: "GET",
          createConnection: () => tunnel.socket,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      req.once("error", reject);
      req.end();
    });
    expect(body).toBe("real:GET:/via-socks");
    scopeSocks.dispose();

    const probeOk = await gateway.testNetwork(
      AgentSandboxProfileSchema.parse({ network: { mode: "direct", allowlist: ["127.0.0.1"] } }),
      `http://127.0.0.1:${target.port}/health`,
    );
    expect(probeOk.ok).toBe(true);
    expect(probeOk.statusCode).toBe(200);

    // Regression: plain http:// probe via HTTP upstream uses direct HEAD without CONNECT :80
    const probeViaHttpUpstream = await gateway.testNetwork(
      AgentSandboxProfileSchema.parse({
        network: { mode: "proxy", proxyUrl: `http://127.0.0.1:${httpUpPort}` },
      }),
      "http://example.invalid/health",
    );
    expect(probeViaHttpUpstream.ok).toBe(true);
    expect(probeViaHttpUpstream.statusCode).toBe(200);
    expect(stripIpv6Brackets("[::1]")).toBe("::1");
  });

  it("exposes authenticated Docker gateway port lazily and tears down on close", async () => {
    const target = await startHttpEchoServer("docker-target");
    const proxy = new AgentNetworkProxy();
    await proxy.startDockerGateway();
    expect(proxy.dockerPort).toBeGreaterThan(0);

    const unauth = await proxyHttpRequest(
      `http://127.0.0.1:${proxy.dockerPort}`,
      `http://127.0.0.1:${target.port}/ping`,
    );
    expect(unauth.status).toBe(407);

    const scope = proxy.registerScope({
      agentId: "docker-agent",
      forDocker: true,
      network: AgentSandboxProfileSchema.parse({
        network: { mode: "direct", allowlist: ["127.0.0.1"] },
      }).network,
    });
    expect(scope.proxyUrl).toContain(`@host.docker.internal:${proxy.dockerPort}`);

    // Connect via 127.0.0.1 using the registered Docker token to avoid requiring /etc/hosts entry in test env
    const authUrl = scope.proxyUrl.replace("@host.docker.internal:", "@127.0.0.1:");
    const allowed = await proxyHttpRequest(authUrl, `http://127.0.0.1:${target.port}/ok`);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toBe("docker-target:GET:/ok");

    const blocked = await proxyHttpRequest(authUrl, "http://blocked.docker.test/secret");
    expect(blocked.status).toBe(403);

    scope.dispose();
    await proxy.close();
    expect(proxy.dockerPort).toBe(0);
  });
});
