/**
 * Per-Agent 沙箱与网络/环境运行档案存储及运行时环境变量编译器。
 *
 * - 档案存放在 `agent-sandboxes.json`（只保存非默认项与加密密钥的键名列表）
 * - 敏感环境变量（匹配 `isSensitiveEnvKey` 或显式通过 `secretValues` 传入）统一写入 `SecretStore`
 * - `compileEnv()` 组装出完全脱敏且仅驻留内存的子进程 `env`，并在 `dispose()` 时回收代理凭据
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AgentSandboxProfileSchema,
  DEFAULT_AGENT_SANDBOX_PROFILE,
  ENV_KEY_PATTERN,
  isDefaultSandboxProfile,
  isSensitiveEnvKey,
  type AgentSandboxProfile,
} from "../../shared/domain/sandbox.js";
import { ensureDir, writeJsonAtomic } from "../boot/atomic.js";
import { buildSanitizedEnv, PROXY_ENV_KEYS } from "../boot/exec.js";
import type { SecretStore } from "../boot/secrets.js";
import type { AgentNetworkProxy } from "./network-proxy.js";

const StoreSchema = z.record(z.string(), AgentSandboxProfileSchema);
const PROXY_ONLY_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export interface AgentSandboxPreferencesDeps {
  readonly file: string;
  readonly secrets: SecretStore;
  readonly sandboxesDir: string;
}

export interface CompiledSandboxEnv {
  readonly env: NodeJS.ProcessEnv;
  readonly dispose: () => void;
}

function secretKeyName(agentId: string, envKey: string): string {
  return `agent-env:${agentId}:${envKey}`;
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

  private readAll(): Record<string, AgentSandboxProfile> {
    if (!existsSync(this.deps.file)) return {};
    try {
      const parsed = StoreSchema.safeParse(JSON.parse(readFileSync(this.deps.file, "utf8")) as unknown);
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  get(agentId: string): AgentSandboxProfile {
    const all = this.readAll();
    const found = all[agentId];
    return found === undefined ? cloneDefaultProfile() : AgentSandboxProfileSchema.parse(found);
  }

  set(
    agentId: string,
    input: AgentSandboxProfile,
    secretValues?: Readonly<Record<string, string>>,
  ): AgentSandboxProfile {
    const parsed = AgentSandboxProfileSchema.parse(input);
    const previous = this.get(agentId);

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
        this.deps.secrets.clear(secretKeyName(agentId, key));
      } else {
        pendingSecrets[key] = value;
      }
    }

    for (const [key, value] of Object.entries(pendingSecrets)) {
      const saved = this.deps.secrets.set(secretKeyName(agentId, key), value);
      if (!saved.ok) throw new Error(saved.error);
      nextSecretKeys.add(key);
    }

    // 已被用户从 secretKeys 移除的旧密钥同步清理
    for (const oldKey of previous.env.secretKeys) {
      if (!nextSecretKeys.has(oldKey)) {
        this.deps.secrets.clear(secretKeyName(agentId, oldKey));
      }
    }

    const proxyUrl = parsed.network.proxyUrl?.trim();
    const caCertPath = parsed.network.caCertPath?.trim();
    const normalized: AgentSandboxProfile = AgentSandboxProfileSchema.parse({
      network: {
        mode: parsed.network.mode,
        ...(proxyUrl ? { proxyUrl } : {}),
        noProxy: dedupeStrings(parsed.network.noProxy),
        ...(caCertPath ? { caCertPath } : {}),
        allowlist: dedupeStrings(parsed.network.allowlist),
        denylist: dedupeStrings(parsed.network.denylist),
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
    });

    const all = this.readAll();
    if (isDefaultSandboxProfile(normalized)) {
      delete all[agentId];
    } else {
      all[agentId] = normalized;
    }
    writeJsonAtomic(this.deps.file, all);
    return normalized;
  }

  async compileEnv(
    agentId: string,
    options: {
      readonly proxy: AgentNetworkProxy;
      readonly extra?: Readonly<Record<string, string>>;
      readonly onBlocked?: (host: string) => void;
    },
  ): Promise<CompiledSandboxEnv> {
    const profile = this.get(agentId);
    const { network, env } = profile;

    const unset = new Set<string>(env.unset);
    const extra: Record<string, string> = { ...env.set };

    for (const key of env.secretKeys) {
      const value = this.deps.secrets.get(secretKeyName(agentId, key));
      if (value !== null) extra[key] = value;
    }

    if (env.isolatedHome) {
      const homeRoot = join(this.deps.sandboxesDir, sanitizeHomeDirSegment(agentId), "home");
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
      isSocksUpstream;

    if (needsLocalGateway) {
      await options.proxy.start();
      const scope = options.proxy.registerScope({
        agentId,
        network,
        ...(options.onBlocked === undefined ? {} : { onBlocked: options.onBlocked }),
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
}
