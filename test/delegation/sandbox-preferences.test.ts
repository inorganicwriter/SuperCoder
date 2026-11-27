/**
 * Per-Agent 环境构建、沙箱偏好存储与 ProviderSelect 能力过滤验证。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestBackend, SecretStore } from "../../src/host/boot/secrets.js";
import { buildSanitizedEnv } from "../../src/host/boot/exec.js";
import { AgentNetworkProxy } from "../../src/host/delegation/network-proxy.js";
import { AgentSandboxPreferences } from "../../src/host/delegation/sandbox-preferences.js";
import { ProviderSelect } from "../../src/host/delegation/provider-select.js";
import type { DelegationProvider, ProviderCapabilities } from "../../src/shared/domain/provider.js";
import {
  AgentSandboxProfileSchema,
  hasActiveProcessSandboxOverrides,
  isDefaultSandboxProfile,
} from "../../src/shared/domain/sandbox.js";
import { makeTempHome } from "../helpers/temp.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn().catch(() => undefined);
  }
});

const CAPS: ProviderCapabilities = {
  readOnly: true,
  resume: false,
  effort: false,
  streaming: false,
  receiptStates: ["queued", "submitted", "returned"],
  fragility: "official",
};

function stubProvider(id: string, supportsSandbox: { env: boolean; network: boolean; worktree: boolean }): DelegationProvider {
  return {
    id,
    capabilities: CAPS,
    supportsSandbox,
    detect: async () => ({ installed: true, binaryPath: id }),
    listSessions: async () => [],
    readSession: async () => [],
    delegate: async () => ({ status: "ok", answer: "done", durationMs: 1 }),
    cancel: async () => undefined,
  };
}

describe("AgentSandboxPreferences & buildSanitizedEnv", () => {
  it("clears inherited proxy keys, unsets custom keys, and prepends PATH without duplicate case keys", () => {
    vi.stubEnv("HTTP_PROXY", "http://host-proxy:8888");
    vi.stubEnv("https_proxy", "http://host-proxy:8888");
    vi.stubEnv("TEMP", "/tmp");

    const env = buildSanitizedEnv({
      unset: ["HTTP_PROXY", "https_proxy", "TEMP"],
      prependPath: ["/custom/bin"],
      extra: { CUSTOM_ENV: "yes" },
    });

    expect(env["HTTP_PROXY"]).toBeUndefined();
    expect(env["https_proxy"]).toBeUndefined();
    expect(env["TEMP"]).toBeUndefined();
    expect(env["CUSTOM_ENV"]).toBe("yes");
    const pathEntries = Object.keys(env).filter((k) => k.toLowerCase() === "path");
    expect(pathEntries).toHaveLength(1);
    expect(env[pathEntries[0]!]?.startsWith("/custom/bin")).toBe(true);
  });

  it("compiles different network modes, isolated home, and encrypted secret vars per agent", async () => {
    const temp = makeTempHome("sc-sandbox-");
    const proxy = new AgentNetworkProxy();
    cleanups.push(async () => {
      await proxy.close();
      temp.cleanup();
    });

    vi.stubEnv("HTTP_PROXY", "http://host-global:8080");
    vi.stubEnv("HTTPS_PROXY", "http://host-global:8080");
    vi.stubEnv("NO_PROXY", "localhost,127.0.0.1,.corp");

    const secrets = new SecretStore(temp.paths.secretsFile, createTestBackend());
    const prefs = new AgentSandboxPreferences({
      file: join(temp.home, "agent-sandboxes.json"),
      secrets,
      sandboxesDir: temp.paths.sandboxesDir,
    });

    prefs.set("codex", AgentSandboxProfileSchema.parse({
      network: { mode: "direct", caCertPath: "/certs/corp.pem" },
      env: { set: { NON_SECRET: "ok", API_KEY: "secret-123" }, isolatedHome: true },
    }));
    prefs.set("claude-code", AgentSandboxProfileSchema.parse({
      network: { mode: "proxy", proxyUrl: "http://127.0.0.1:7890", allowlist: ["api.anthropic.com"] },
    }));
    prefs.set("antigravity", AgentSandboxProfileSchema.parse({
      network: { mode: "offline" },
    }));

    // 明文配置文件不得包含敏感 API_KEY 值
    const savedJson = readFileSync(join(temp.home, "agent-sandboxes.json"), "utf8");
    expect(savedJson).not.toContain("secret-123");

    const codexEnv = await prefs.compileEnv("codex", { proxy });
    expect(codexEnv.env["HTTP_PROXY"]).toBeUndefined();
    expect(codexEnv.env["HTTPS_PROXY"]).toBeUndefined();
    expect(codexEnv.env["NO_PROXY"]).toBeUndefined();
    expect(codexEnv.env["API_KEY"]).toBe("secret-123");
    expect(codexEnv.env["NON_SECRET"]).toBe("ok");
    expect(codexEnv.env["NODE_EXTRA_CA_CERTS"]).toBe("/certs/corp.pem");
    expect(codexEnv.env["HOME"]).toContain("codex");
    expect(existsSync(codexEnv.env["HOME"]!)).toBe(true);
    codexEnv.dispose();

    const claudeEnv = await prefs.compileEnv("claude-code", { proxy });
    expect(claudeEnv.env["HTTP_PROXY"]).toMatch(/^http:\/\/claude-code:[^@]+@127\.0\.0\.1:\d+$/);
    expect(claudeEnv.env["HTTPS_PROXY"]).toBe(claudeEnv.env["HTTP_PROXY"]);
    // 保留宿主 NO_PROXY，不抹掉 localhost
    expect(claudeEnv.env["NO_PROXY"]).toBe("localhost,127.0.0.1,.corp");
    claudeEnv.dispose();

    const offlineEnv = await prefs.compileEnv("antigravity", { proxy });
    expect(offlineEnv.env["NO_PROXY"]).toBeUndefined();
    offlineEnv.dispose();
  });

  it("allows blocked hosts in allowlist/denylist while rejecting offline mode", () => {
    const temp = makeTempHome("sc-allowhost-");
    cleanups.push(async () => temp.cleanup());
    const secrets = new SecretStore(temp.paths.secretsFile, createTestBackend());
    const prefs = new AgentSandboxPreferences({
      file: join(temp.home, "agent-sandboxes.json"),
      secrets,
      sandboxesDir: temp.paths.sandboxesDir,
    });

    prefs.set("codex", AgentSandboxProfileSchema.parse({
      network: {
        mode: "proxy",
        proxyUrl: "http://127.0.0.1:7890",
        allowlist: ["api.openai.com"],
        denylist: ["extra.test", "*.blocked.test"],
      },
    }));
    const updated = prefs.allowHost("codex", "  sub.blocked.test. ");
    expect(updated.network.allowlist).toEqual(["api.openai.com", "sub.blocked.test"]);
    expect(updated.network.denylist).toEqual(["extra.test"]);

    prefs.set("claude-code", AgentSandboxProfileSchema.parse({ network: { mode: "offline" } }));
    expect(() => prefs.allowHost("claude-code", "api.anthropic.com")).toThrow();
  });

  it("enables local audit gateway when auditOutbound is true and locks allowlists cleanly", async () => {
    const temp = makeTempHome("sc-audit-");
    const proxy = new AgentNetworkProxy();
    cleanups.push(async () => {
      await proxy.close();
      temp.cleanup();
    });
    const secrets = new SecretStore(temp.paths.secretsFile, createTestBackend());
    const prefs = new AgentSandboxPreferences({
      file: join(temp.home, "agent-sandboxes.json"),
      secrets,
      sandboxesDir: temp.paths.sandboxesDir,
    });

    const auditProfile = prefs.set("codex", AgentSandboxProfileSchema.parse({
      network: { mode: "direct", auditOutbound: true, denylist: ["evil.test"] },
    }));
    expect(hasActiveProcessSandboxOverrides(auditProfile)).toBe(true);
    expect(isDefaultSandboxProfile(auditProfile)).toBe(false);

    const compiled = await prefs.compileEnv("codex", { proxy });
    expect(compiled.env["HTTP_PROXY"]).toMatch(/^http:\/\/codex:[^@]+@127\.0\.0\.1:\d+$/);
    compiled.dispose();

    const merged = prefs.lockAllowlist("codex", ["api.openai.com", "evil.test"], true);
    expect(merged.network.allowlist).toEqual(["api.openai.com", "evil.test"]);
    expect(merged.network.denylist).toEqual([]);

    const replaced = prefs.lockAllowlist("codex", ["only.example.com"], false);
    expect(replaced.network.allowlist).toEqual(["only.example.com"]);
  });

  it("skips desktop-only providers when process sandbox overrides are active", async () => {
    const select = new ProviderSelect([
      {
        id: "opencode",
        label: "OpenCode",
        entries: [
          { level: 1, provider: stubProvider("opencode-desktop", { env: false, network: false, worktree: true }) },
          { level: 3, provider: stubProvider("opencode-acp", { env: true, network: true, worktree: true }) },
        ],
        probe: {
          providerId: "opencode",
          locate: async () => null,
          listSessions: async () => [],
          readSession: async () => [],
        },
      },
      {
        id: "kimi-code",
        label: "Kimi Code",
        entries: [
          { level: 1, provider: stubProvider("kimi-code", { env: false, network: false, worktree: true }) },
        ],
        probe: {
          providerId: "kimi-code",
          locate: async () => null,
          listSessions: async () => [],
          readSession: async () => [],
        },
      },
    ]);

    const defaultCandidates = await select.resolveCandidates("opencode", { requireProcessSandbox: false });
    expect(defaultCandidates[0]?.provider.id).toBe("opencode-desktop");

    const sandboxCandidates = await select.resolveCandidates("opencode", { requireProcessSandbox: true });
    expect(sandboxCandidates).toHaveLength(1);
    expect(sandboxCandidates[0]?.provider.id).toBe("opencode-acp");

    expect(select.sandboxCapabilitiesOf("opencode").network).toBe(true);
    expect(select.sandboxCapabilitiesOf("kimi-code").network).toBe(false);
    await expect(select.resolveCandidates("kimi-code", { requireProcessSandbox: true })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  it("compiles docker container backend with container-only env, gateway proxy URL, mounts, and offline coercion", async () => {
    const temp = makeTempHome("sc-docker-prefs-");
    const proxy = new AgentNetworkProxy();
    cleanups.push(async () => {
      await proxy.close();
      temp.cleanup();
    });

    vi.stubEnv("HTTP_PROXY", "http://host-proxy:8888");
    const secrets = new SecretStore(temp.paths.secretsFile, createTestBackend());
    const prefs = new AgentSandboxPreferences({
      file: join(temp.home, "agent-sandboxes.json"),
      secrets,
      sandboxesDir: temp.paths.sandboxesDir,
    });

    const profile = prefs.set("codex", AgentSandboxProfileSchema.parse({
      network: {
        mode: "proxy",
        proxyUrl: "http://127.0.0.1:7890",
        allowlist: ["api.openai.com"],
        caCertPath: "/host/ca.pem",
      },
      env: {
        set: { NON_SECRET: "ok", API_KEY: "secret-docker" },
        unset: ["HTTP_PROXY", "NON_SECRET"],
        prependPath: ["/opt/tools/bin"],
        isolatedHome: true,
      },
      backend: {
        kind: "docker",
        docker: {
          image: "ghcr.io/supercoder/codex:latest",
          networkIsolation: "proxy-only",
          memoryLimit: "2g",
          cpuLimit: 2,
          readOnlyRoot: true,
          extraMounts: [{ host: "/host/docs", container: "/mnt/docs", readOnly: true }],
        },
      },
    }));

    expect(hasActiveProcessSandboxOverrides(profile)).toBe(true);
    expect(isDefaultSandboxProfile(profile)).toBe(false);

    const compiled = await prefs.compileEnv("codex", {
      proxy,
      extra: { SUPERCODER_AGENT_API_KEY: "model-secret", HTTP_PROXY: "http://127.0.0.1:9999" },
    });
    expect(compiled.docker).toBeDefined();
    expect(compiled.docker?.networkIsolation).toBe("proxy-only");
    expect(compiled.docker?.extraMounts).toEqual(
      expect.arrayContaining([
        { host: "/host/docs", container: "/mnt/docs", readOnly: true },
        expect.objectContaining({ container: "/home/supercoder", readOnly: false }),
        { host: "/host/ca.pem", container: "/etc/supercoder/ca.pem", readOnly: true },
      ]),
    );
    // 宿主 Windows PATH/SystemRoot 等不得进入容器 env
    expect(compiled.env["SystemRoot"]).toBeUndefined();
    expect(compiled.env["HOME"]).toBe("/home/supercoder");
    expect(compiled.env["NODE_EXTRA_CA_CERTS"]).toBe("/etc/supercoder/ca.pem");
    expect(compiled.env["API_KEY"]).toBe("secret-docker");
    expect(compiled.env["NON_SECRET"]).toBeUndefined();
    expect(compiled.env["PATH"]?.startsWith("/opt/tools/bin:/usr/local/sbin:")).toBe(true);
    expect(compiled.env["SUPERCODER_AGENT_API_KEY"]).toBe("model-secret");
    // options.extra 传入的回环代理也会被改写为 host.docker.internal
    expect(compiled.env["HTTP_PROXY"]).toBe("http://host.docker.internal:9999");
    expect(compiled.env["HTTPS_PROXY"]).toMatch(/^http:\/\/codex:[^@]+@host\.docker\.internal:\d+$/);
    expect(proxy.dockerPort).toBeGreaterThan(0);
    compiled.dispose();

    // 离线网络策略自动收敛容器为 --network none
    prefs.set("claude-code", AgentSandboxProfileSchema.parse({
      network: { mode: "offline" },
      backend: {
        kind: "docker",
        docker: { image: "ghcr.io/supercoder/claude:latest", networkIsolation: "proxy-only" },
      },
    }));
    const offlineDocker = await prefs.compileEnv("claude-code", { proxy });
    expect(offlineDocker.docker?.networkIsolation).toBe("none");
    expect(offlineDocker.env["HTTP_PROXY"]).toBeUndefined();
    offlineDocker.dispose();
  });

  it("allows container-only resolution when allowDockerFallback is enabled without host CLI installed", async () => {
    const select = new ProviderSelect([
      {
        id: "container-agent",
        label: "Container Agent",
        entries: [
          {
            level: 3,
            provider: {
              ...stubProvider("container-acp", { env: true, network: true, worktree: true }),
              detect: async () => ({ installed: false, reason: "not installed on host" }),
            },
          },
        ],
        probe: {
          providerId: "container-agent",
          locate: async () => null,
          listSessions: async () => [],
          readSession: async () => [],
        },
      },
    ]);

    await expect(
      select.resolveCandidates("container-agent", { requireProcessSandbox: true }),
    ).rejects.toMatchObject({ code: "not_found" });

    const fallback = await select.resolveCandidates("container-agent", {
      requireProcessSandbox: true,
      allowDockerFallback: true,
    });
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.provider.id).toBe("container-acp");
  });
});
