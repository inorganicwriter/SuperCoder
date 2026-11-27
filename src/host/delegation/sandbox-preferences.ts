/**
 * Per-Agent 沙箱与网络/环境运行档案存储及运行时环境变量编译器。
 *
 * - 档案存放在 `agent-sandboxes.json`（只保存非默认项与加密密钥的键名列表）
 * - 敏感环境变量（匹配 `isSensitiveEnvKey` 或显式通过 `secretValues` 传入）统一写入 `SecretStore`
 * - `compileEnv()` 组装出完全脱敏且仅驻留内存的子进程 `env`，并在 `dispose()` 时回收代理凭据
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  AgentSandboxProfileSchema,
  DEFAULT_AGENT_SANDBOX_PROFILE,
  ENV_KEY_PATTERN,
  isDefaultSandboxProfile,
  isSensitiveEnvKey,
  matchHostPattern,
  type AgentSandboxProfile,
  type DockerBackendConfig,
} from "../../shared/domain/sandbox.js";
import { ensureDir, writeJsonAtomic } from "../boot/atomic.js";
import { rewriteProxyUrlForDocker } from "../boot/docker-runtime.js";
import { buildSanitizedEnv, PROXY_ENV_KEYS } from "../boot/exec.js";
import { fail } from "../boot/failure.js";
import type { SecretStore } from "../boot/secrets.js";
import type { AgentNetworkProxy } from "./network-proxy.js";

const StoreSchema = z.record(z.string(), AgentSandboxProfileSchema);
const WorkspaceStoreSchema = z.record(z.string(), StoreSchema);
const PROXY_ONLY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;
const DEFAULT_CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface AgentSandboxPreferencesDeps {
  readonly file: string;
  readonly secrets: SecretStore;
  readonly sandboxesDir: string;
  readonly dockerOwnerTag?: string;
}

export interface CompiledSandboxEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly docker?: DockerBackendConfig & { readonly ownerTag?: string };
  readonly dispose: () => void;
}

function secretKeyName(agentId: string, envKey: string, workspaceId?: string): string {
  return workspaceId
    ? `agent-env:${agentId}@ws:${workspaceId}:${envKey}`
    : `agent-env:${agentId}:${envKey}`;
}

function cloneDefaultProfile(): AgentSandboxProfile {
  return AgentSandboxProfileSchema.parse(DEFAULT_AGENT_SANDBOX_PROFILE);
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of values) {
    const trimmed = item.trim();
    if (trimmed !== "" && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function sanitizeHomeDirSegment(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9_-]/g, "_");
}

export class AgentSandboxPreferences {
  constructor(private readonly deps: AgentSandboxPreferencesDeps) {}

  private get workspacesFile(): string {
    return join(dirname(this.deps.file), "agent-sandboxes-workspaces.json");
  }

  private readAll(): Record<string, AgentSandboxProfile> {
    if (!existsSync(this.deps.file)) return {};
    try {
      const parsed = StoreSchema.safeParse(JSON.parse(readFileSync(this.deps.file, "utf8")) as unknown);
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  private readAllWorkspaces(): Record<string, Record<string, AgentSandboxProfile>> {
    if (!existsSync(this.workspacesFile)) return {};
    try {
      const parsed = WorkspaceStoreSchema.safeParse(
        JSON.parse(readFileSync(this.workspacesFile, "utf8")) as unknown,
      );
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  hasWorkspaceOverride(agentId: string, workspaceId: string): boolean {
    const trimmedWs = workspaceId.trim();
    if (trimmedWs === "") return false;
    return this.readAllWorkspaces()[trimmedWs]?.[agentId] !== undefined;
  }

  get(agentId: string, workspaceId?: string): AgentSandboxProfile {
    const trimmedWs = workspaceId?.trim();
    if (trimmedWs) {
      const wsProfile = this.readAllWorkspaces()[trimmedWs]?.[agentId];
      if (wsProfile !== undefined) return AgentSandboxProfileSchema.parse(wsProfile);
    }
    const all = this.readAll();
    const found = all[agentId];
    return found === undefined ? cloneDefaultProfile() : AgentSandboxProfileSchema.parse(found);
  }

  set(
    agentId: string,
    input: AgentSandboxProfile,
    secretValues?: Readonly<Record<string, string>>,
    options?: { readonly workspaceId?: string },
  ): AgentSandboxProfile {
    const scopeWs = options?.workspaceId?.trim() ? options.workspaceId.trim() : undefined;
    const parsed = AgentSandboxProfileSchema.parse(input);
    const previous =
      scopeWs !== undefined
        ? (this.readAllWorkspaces()[scopeWs]?.[agentId] ?? cloneDefaultProfile())
        : this.get(agentId);

    const plainSet: Record<string, string> = {};
    const nextSecretKeys = new Set<string>(parsed.env.secretKeys);
    const pendingSecrets: Record<string, string> = {};

    for (const [key, value] of Object.entries(parsed.env.set)) {
      if (isSensitiveEnvKey(key)) {
        pendingSecrets[key] = value;
      } else {
        plainSet[key] = value;
      }
    }

    for (const [key, value] of Object.entries(secretValues ?? {})) {
      if (!ENV_KEY_PATTERN.test(key)) {
        throw new Error(`非法环境变量名：${key}`);
      }
      if (value === "") {
        nextSecretKeys.delete(key);
        this.deps.secrets.clear(secretKeyName(agentId, key, scopeWs));
      } else {
        pendingSecrets[key] = value;
      }
    }

    for (const [key, value] of Object.entries(pendingSecrets)) {
      const saved = this.deps.secrets.set(secretKeyName(agentId, key, scopeWs), value);
      if (!saved.ok) throw new Error(saved.error);
      nextSecretKeys.add(key);
    }

    if (scopeWs !== undefined) {
      for (const key of nextSecretKeys) {
        if (Object.hasOwn(pendingSecrets, key)) continue;
        if (this.deps.secrets.get(secretKeyName(agentId, key, scopeWs)) !== null) continue;
        const inherited = this.deps.secrets.get(secretKeyName(agentId, key));
        if (inherited !== null) {
          const copied = this.deps.secrets.set(secretKeyName(agentId, key, scopeWs), inherited);
          if (!copied.ok) throw new Error(copied.error);
        }
      }
    }

    // 已被用户从 secretKeys 移除的旧密钥同步清理
    for (const oldKey of previous.env.secretKeys) {
      if (!nextSecretKeys.has(oldKey)) {
        this.deps.secrets.clear(secretKeyName(agentId, oldKey, scopeWs));
      }
    }

    const proxyUrl = parsed.network.proxyUrl?.trim();
    const caCertPath = parsed.network.caCertPath?.trim();
    const backendDocker = parsed.backend.docker;
    const normalizedBackend =
      parsed.backend.kind === "docker" && backendDocker !== undefined
        ? {
            kind: "docker" as const,
            docker: {
              image: backendDocker.image.trim(),
              networkIsolation: backendDocker.networkIsolation,
              ...(backendDocker.memoryLimit?.trim() ? { memoryLimit: backendDocker.memoryLimit.trim() } : {}),
              ...(backendDocker.cpuLimit === undefined ? {} : { cpuLimit: backendDocker.cpuLimit }),
              readOnlyRoot: backendDocker.readOnlyRoot,
              extraMounts: backendDocker.extraMounts.map((mount) => ({
                host: mount.host.trim(),
                container: mount.container.trim(),
                readOnly: mount.readOnly,
              })),
            },
          }
        : { kind: "process" as const };

    const normalized: AgentSandboxProfile = AgentSandboxProfileSchema.parse({
      network: {
        mode: parsed.network.mode,
        ...(proxyUrl ? { proxyUrl } : {}),
        noProxy: dedupeStrings(parsed.network.noProxy),
        ...(caCertPath ? { caCertPath } : {}),
        allowlist: dedupeStrings(parsed.network.allowlist),
        denylist: dedupeStrings(parsed.network.denylist),
        ...(parsed.network.auditOutbound === true ? { auditOutbound: true } : {}),
      },
      env: {
        set: plainSet,
        secretKeys: [...nextSecretKeys].sort(),
        unset: dedupeStrings(parsed.env.unset),
        prependPath: dedupeStrings(parsed.env.prependPath),
        isolatedHome: parsed.env.isolatedHome,
      },
      workspace: {
        isolation: parsed.workspace.isolation,
      },
      backend: normalizedBackend,
    });

    if (scopeWs !== undefined) {
      const allWs = this.readAllWorkspaces();
      allWs[scopeWs] = {
        ...allWs[scopeWs],
        [agentId]: normalized,
      };
      writeJsonAtomic(this.workspacesFile, allWs);
      return normalized;
    }

    const all = this.readAll();
    if (isDefaultSandboxProfile(normalized)) {
      delete all[agentId];
    } else {
      all[agentId] = normalized;
    }
    writeJsonAtomic(this.deps.file, all);
    return normalized;
  }

  clearWorkspaceOverride(agentId: string, workspaceId: string): AgentSandboxProfile {
    const scopeWs = workspaceId.trim();
    if (scopeWs !== "") {
      const allWs = this.readAllWorkspaces();
      const wsMap = allWs[scopeWs];
      const existing = wsMap?.[agentId];
      if (wsMap !== undefined && existing !== undefined) {
        for (const key of existing.env.secretKeys) {
          this.deps.secrets.clear(secretKeyName(agentId, key, scopeWs));
        }
        delete wsMap[agentId];
        if (Object.keys(wsMap).length === 0) {
          delete allWs[scopeWs];
        }
        writeJsonAtomic(this.workspacesFile, allWs);
      }
    }
    return this.get(agentId);
  }

  allowHost(agentId: string, rawHost: string, workspaceId?: string): AgentSandboxProfile {
    const host = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
    if (host === "") fail("invalid_params", "域名不能为空。");
    const targetWs =
      workspaceId !== undefined && this.hasWorkspaceOverride(agentId, workspaceId)
        ? workspaceId.trim()
        : undefined;
    const profile = this.get(agentId, targetWs);
    if (profile.network.mode === "offline") {
      fail("denied", "当前 Agent 处于离线模式，请先切换网络策略后再放行域名。");
    }
    const nextDenylist = profile.network.denylist.filter((pattern) => !matchHostPattern(host, pattern));
    const alreadyAllowed =
      profile.network.allowlist.length === 0 ||
      profile.network.allowlist.some((pattern) => matchHostPattern(host, pattern));
    const nextAllowlist = alreadyAllowed
      ? [...profile.network.allowlist]
      : [...profile.network.allowlist, host];

    return this.set(
      agentId,
      {
        ...profile,
        network: {
          ...profile.network,
          allowlist: nextAllowlist,
          denylist: nextDenylist,
        },
      },
      undefined,
      targetWs === undefined ? undefined : { workspaceId: targetWs },
    );
  }

  lockAllowlist(
    agentId: string,
    rawHosts: readonly string[],
    merge = true,
    workspaceId?: string,
  ): AgentSandboxProfile {
    const hosts = dedupeStrings(
      rawHosts.map((item) => item.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "")),
    );
    if (hosts.length === 0) fail("invalid_params", "域名列表不能为空。");
    const targetWs =
      workspaceId !== undefined && this.hasWorkspaceOverride(agentId, workspaceId)
        ? workspaceId.trim()
        : undefined;
    const profile = this.get(agentId, targetWs);
    if (profile.network.mode === "offline") {
      fail("denied", "当前 Agent 处于离线模式，请先切换网络策略后再锁定白名单。");
    }
    const nextDenylist = profile.network.denylist.filter(
      (pattern) => !hosts.some((host) => matchHostPattern(host, pattern)),
    );
    const nextAllowlist =
      merge && profile.network.allowlist.length > 0
        ? dedupeStrings([...profile.network.allowlist, ...hosts])
        : hosts;

    return this.set(
      agentId,
      {
        ...profile,
        network: {
          ...profile.network,
          allowlist: nextAllowlist,
          denylist: nextDenylist,
        },
      },
      undefined,
      targetWs === undefined ? undefined : { workspaceId: targetWs },
    );
  }

  async compileEnv(
    agentId: string,
    options: {
      readonly proxy: AgentNetworkProxy;
      readonly workspaceId?: string;
      readonly extra?: Readonly<Record<string, string>>;
      readonly onBlocked?: (host: string) => void;
      readonly onAllowed?: (host: string) => void;
    },
  ): Promise<CompiledSandboxEnv> {
    const activeWs =
      options.workspaceId !== undefined && this.hasWorkspaceOverride(agentId, options.workspaceId)
        ? options.workspaceId.trim()
        : undefined;
    const profile = this.get(agentId, activeWs);
    if (profile.backend.kind === "docker" && profile.backend.docker !== undefined) {
      return this.compileDockerEnv(agentId, activeWs, profile, options);
    }
    const { network, env } = profile;

    const unset = new Set<string>(env.unset);
    const extra: Record<string, string> = { ...env.set };

    for (const key of env.secretKeys) {
      const value = this.deps.secrets.get(secretKeyName(agentId, key, activeWs));
      if (value !== null) extra[key] = value;
    }

    if (env.isolatedHome) {
      const homeRoot = join(
        this.deps.sandboxesDir,
        sanitizeHomeDirSegment(activeWs !== undefined ? `${agentId}__${activeWs}` : agentId),
        "home",
      );
      const configDir = join(homeRoot, ".config");
      const dataDir = join(homeRoot, ".local", "share");
      const stateDir = join(homeRoot, ".local", "state");
      const codexDir = join(homeRoot, ".codex");
      ensureDir(homeRoot);
      ensureDir(configDir);
      ensureDir(dataDir);
      ensureDir(stateDir);
      ensureDir(codexDir);
      extra["HOME"] = homeRoot;
      extra["USERPROFILE"] = homeRoot;
      extra["XDG_CONFIG_HOME"] = configDir;
      extra["XDG_DATA_HOME"] = dataDir;
      extra["XDG_STATE_HOME"] = stateDir;
      extra["CODEX_HOME"] = codexDir;
    }

    let disposeScope: (() => void) | null = null;
    const isSocksUpstream =
      network.mode === "proxy" && /^socks5h?:/i.test(network.proxyUrl?.trim() ?? "");
    const needsLocalGateway =
      network.mode === "offline" ||
      network.allowlist.length > 0 ||
      network.denylist.length > 0 ||
      network.auditOutbound === true ||
      isSocksUpstream;

    if (needsLocalGateway) {
      await options.proxy.start();
      const scope = options.proxy.registerScope({
        agentId,
        network,
        ...(options.onBlocked === undefined ? {} : { onBlocked: options.onBlocked }),
        ...(options.onAllowed === undefined ? {} : { onAllowed: options.onAllowed }),
      });
      disposeScope = scope.dispose;
      // 仅在离线模式下清理 NO_PROXY；其余模式保留宿主 NO_PROXY（若用户未显式覆盖），以免破坏本机 localhost 服务访问。
      const keysToClear = network.mode === "offline" ? PROXY_ENV_KEYS : PROXY_ONLY_KEYS;
      for (const key of keysToClear) unset.add(key);
      for (const key of PROXY_ONLY_KEYS) {
        extra[key] = scope.proxyUrl;
      }
    } else if (network.mode === "direct") {
      for (const key of PROXY_ENV_KEYS) unset.add(key);
    } else if (network.mode === "proxy" && network.proxyUrl) {
      for (const key of PROXY_ONLY_KEYS) unset.add(key);
      for (const key of PROXY_ONLY_KEYS) {
        extra[key] = network.proxyUrl;
      }
    }

    if (network.noProxy.length > 0 && network.mode !== "offline") {
      const joined = network.noProxy.join(",");
      extra["NO_PROXY"] = joined;
      extra["no_proxy"] = joined;
    } else if (network.mode === "offline") {
      unset.add("NO_PROXY");
      unset.add("no_proxy");
    }

    if (network.caCertPath && network.caCertPath.trim() !== "") {
      const caPath = network.caCertPath.trim();
      extra["NODE_EXTRA_CA_CERTS"] = caPath;
      extra["SSL_CERT_FILE"] = caPath;
      extra["CURL_CA_BUNDLE"] = caPath;
    }

    for (const [key, value] of Object.entries(options.extra ?? {})) {
      extra[key] = value;
    }

    const compiled = buildSanitizedEnv({
      extra,
      unset: [...unset],
      prependPath: env.prependPath,
    });

    return {
      env: compiled,
      dispose: () => {
        disposeScope?.();
      },
    };
  }

  private async compileDockerEnv(
    agentId: string,
    activeWs: string | undefined,
    profile: AgentSandboxProfile,
    options: {
      readonly proxy: AgentNetworkProxy;
      readonly extra?: Readonly<Record<string, string>>;
      readonly onBlocked?: (host: string) => void;
      readonly onAllowed?: (host: string) => void;
    },
  ): Promise<CompiledSandboxEnv> {
    const dockerCfg = profile.backend.docker!;
    const { network, env } = profile;
    const effectiveIsolation = network.mode === "offline" ? "none" : dockerCfg.networkIsolation;
    const containerEnv: Record<string, string> = { ...env.set };
    const extraMounts = [...dockerCfg.extraMounts];

    for (const key of env.secretKeys) {
      const value = this.deps.secrets.get(secretKeyName(agentId, key, activeWs));
      if (value !== null) containerEnv[key] = value;
    }

    // 先处理用户显式清理的键，再注入托管的隔离目录、CA 证书、代理路由与运行期额外变量。
    for (const key of env.unset) {
      delete containerEnv[key];
    }

    if (env.isolatedHome) {
      const homeRoot = join(
        this.deps.sandboxesDir,
        sanitizeHomeDirSegment(activeWs !== undefined ? `${agentId}__${activeWs}` : agentId),
        "home",
      );
      ensureDir(homeRoot);
      ensureDir(join(homeRoot, ".config"));
      ensureDir(join(homeRoot, ".local", "share"));
      ensureDir(join(homeRoot, ".local", "state"));
      ensureDir(join(homeRoot, ".codex"));
      extraMounts.push({ host: homeRoot, container: "/home/supercoder", readOnly: false });
      containerEnv["HOME"] = "/home/supercoder";
      containerEnv["XDG_CONFIG_HOME"] = "/home/supercoder/.config";
      containerEnv["XDG_DATA_HOME"] = "/home/supercoder/.local/share";
      containerEnv["XDG_STATE_HOME"] = "/home/supercoder/.local/state";
      containerEnv["CODEX_HOME"] = "/home/supercoder/.codex";
    }

    if (network.caCertPath && network.caCertPath.trim() !== "" && effectiveIsolation !== "none") {
      extraMounts.push({
        host: network.caCertPath.trim(),
        container: "/etc/supercoder/ca.pem",
        readOnly: true,
      });
      containerEnv["NODE_EXTRA_CA_CERTS"] = "/etc/supercoder/ca.pem";
      containerEnv["SSL_CERT_FILE"] = "/etc/supercoder/ca.pem";
      containerEnv["CURL_CA_BUNDLE"] = "/etc/supercoder/ca.pem";
    }

    let disposeScope: (() => void) | null = null;
    if (effectiveIsolation !== "none") {
      const routeViaGateway =
        effectiveIsolation === "proxy-only" ||
        network.mode === "proxy" ||
        network.mode === "inherit" ||
        network.allowlist.length > 0 ||
        network.denylist.length > 0 ||
        network.auditOutbound === true;
      if (routeViaGateway) {
        await options.proxy.startDockerGateway();
        const scope = options.proxy.registerScope({
          agentId,
          network,
          forDocker: true,
          ...(options.onBlocked === undefined ? {} : { onBlocked: options.onBlocked }),
          ...(options.onAllowed === undefined ? {} : { onAllowed: options.onAllowed }),
        });
        disposeScope = scope.dispose;
        for (const key of PROXY_ONLY_KEYS) {
          containerEnv[key] = scope.proxyUrl;
        }
        const noProxyList = dedupeStrings([
          "host.docker.internal",
          "localhost",
          "127.0.0.1",
          ...(effectiveIsolation === "bridge" ? network.noProxy : []),
        ]);
        const joined = noProxyList.join(",");
        containerEnv["NO_PROXY"] = joined;
        containerEnv["no_proxy"] = joined;
      } else if (network.noProxy.length > 0) {
        const joined = network.noProxy.join(",");
        containerEnv["NO_PROXY"] = joined;
        containerEnv["no_proxy"] = joined;
      }
    }

    const proxyKeySet = new Set<string>(PROXY_ONLY_KEYS);
    for (const [key, value] of Object.entries(options.extra ?? {})) {
      containerEnv[key] = proxyKeySet.has(key) ? rewriteProxyUrlForDocker(value) : value;
    }

    if (env.prependPath.length > 0) {
      const prefix = env.prependPath.join(":");
      const current = containerEnv["PATH"] ?? DEFAULT_CONTAINER_PATH;
      containerEnv["PATH"] = `${prefix}:${current}`;
    }

    return {
      env: containerEnv,
      docker: {
        ...dockerCfg,
        networkIsolation: effectiveIsolation,
        extraMounts,
        ...(this.deps.dockerOwnerTag ? { ownerTag: this.deps.dockerOwnerTag } : {}),
      },
      dispose: () => {
        disposeScope?.();
      },
    };
  }
}
