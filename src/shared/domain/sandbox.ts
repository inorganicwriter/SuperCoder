/**
 * Per-Agent 网络与环境沙箱档案，以及 Worktree 工作区隔离契约。
 *
 * 位于 `src/shared/domain`，只依赖纯 TypeScript 与 zod（无 node:* / react / electron）。
 */

import { z } from "zod";

export const NetworkModeSchema = z.enum(["inherit", "direct", "proxy", "offline"]);
export type NetworkMode = z.infer<typeof NetworkModeSchema>;

export const WorkspaceIsolationSchema = z.enum(["shared", "worktree"]);
export type WorkspaceIsolation = z.infer<typeof WorkspaceIsolationSchema>;

export const DockerNetworkIsolationSchema = z.enum(["proxy-only", "bridge", "none"]);
export type DockerNetworkIsolation = z.infer<typeof DockerNetworkIsolationSchema>;

export const DockerMountSchema = z.object({
  host: z.string().trim().min(1).max(4096),
  container: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .refine((value) => value.startsWith("/"), {
      message: "容器内挂载路径必须是以 / 开头的绝对路径",
    }),
  readOnly: z.boolean().default(true),
});
export type DockerMount = z.infer<typeof DockerMountSchema>;

export const DockerMemoryLimitSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d*[kmgKMG]?$/, "内存上限格式无效（例如 2g、512m）");

export const DockerBackendConfigSchema = z.object({
  image: z.string().trim().max(512).default(""),
  networkIsolation: DockerNetworkIsolationSchema.default("proxy-only"),
  memoryLimit: DockerMemoryLimitSchema.optional(),
  cpuLimit: z.number().positive().max(64).optional(),
  readOnlyRoot: z.boolean().default(false),
  extraMounts: z.array(DockerMountSchema).max(16).default(() => []),
});
export type DockerBackendConfig = z.infer<typeof DockerBackendConfigSchema>;

export const SandboxBackendSchema = z
  .object({
    kind: z.enum(["process", "docker"]).default("process"),
    docker: DockerBackendConfigSchema.optional(),
  })
  .superRefine((backend, ctx) => {
    if (backend.kind === "docker" && (!backend.docker || backend.docker.image.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["docker", "image"],
        message: "启用 Docker 容器隔离时必须填写镜像名称",
      });
    }
  });
export type SandboxBackend = z.infer<typeof SandboxBackendSchema>;

export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const EnvKeySchema = z.string().regex(ENV_KEY_PATTERN, "环境变量名仅支持字母、数字与下划线，且不能以数字开头");

const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:", "socks5:", "socks5h:"]);

/** 校验代理 URL 是否为合法的 http(s) / socks5(h) 地址。 */
export function isValidProxyUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol) && parsed.hostname !== "";
  } catch {
    return false;
  }
}

export const SandboxNetworkSchema = z
  .object({
    mode: NetworkModeSchema.default("inherit"),
    proxyUrl: z
      .string()
      .trim()
      .max(2048)
      .optional()
      .refine((value) => value === undefined || value === "" || isValidProxyUrl(value), {
        message: "代理地址必须是合法的 http://、https:// 或 socks5:// URL",
      }),
    noProxy: z.array(z.string().trim().min(1).max(256)).max(100).default(() => []),
    caCertPath: z.string().trim().max(4096).optional(),
    allowlist: z.array(z.string().trim().min(1).max(256)).max(200).default(() => []),
    denylist: z.array(z.string().trim().min(1).max(256)).max(200).default(() => []),
    auditOutbound: z.boolean().optional(),
  })
  .superRefine((network, ctx) => {
    if (network.mode === "proxy" && (network.proxyUrl === undefined || network.proxyUrl.trim() === "")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["proxyUrl"],
        message: "选择独立代理模式时必须填写代理地址",
      });
    }
  });
export type SandboxNetwork = z.infer<typeof SandboxNetworkSchema>;

export const SandboxEnvSchema = z.object({
  set: z.record(EnvKeySchema, z.string().max(8192)).default(() => ({})),
  secretKeys: z.array(EnvKeySchema).max(100).default(() => []),
  unset: z.array(EnvKeySchema).max(100).default(() => []),
  prependPath: z.array(z.string().trim().min(1).max(4096)).max(32).default(() => []),
  isolatedHome: z.boolean().default(false),
});
export type SandboxEnv = z.infer<typeof SandboxEnvSchema>;

export const SandboxWorkspaceSchema = z.object({
  isolation: WorkspaceIsolationSchema.default("shared"),
});
export type SandboxWorkspace = z.infer<typeof SandboxWorkspaceSchema>;

export const AgentSandboxProfileSchema = z.object({
  network: SandboxNetworkSchema.default(() => ({
    mode: "inherit" as const,
    noProxy: [],
    allowlist: [],
    denylist: [],
  })),
  env: SandboxEnvSchema.default(() => ({
    set: {},
    secretKeys: [],
    unset: [],
    prependPath: [],
    isolatedHome: false,
  })),
  workspace: SandboxWorkspaceSchema.default(() => ({
    isolation: "shared" as const,
  })),
  backend: SandboxBackendSchema.default(() => ({
    kind: "process" as const,
  })),
});
export type AgentSandboxProfile = z.infer<typeof AgentSandboxProfileSchema>;

export const DEFAULT_AGENT_SANDBOX_PROFILE: AgentSandboxProfile = AgentSandboxProfileSchema.parse({});

export const AGENT_ALLOWLIST_PRESETS: Readonly<Record<string, readonly string[]>> = {
  codex: ["*.openai.com", "*.chatgpt.com"],
  "claude-code": ["*.anthropic.com", "api.claude.ai"],
  "deepseek-harness": ["api.deepseek.com", "*.deepseek.com"],
  opencode: ["*.openai.com", "*.anthropic.com", "api.deepseek.com"],
  antigravity: ["*.googleapis.com", "*.google.com"],
  "kimi-code": ["api.moonshot.cn", "*.moonshot.cn", "*.kimi.com"],
};

export const SandboxCapabilitiesSchema = z.object({
  env: z.boolean(),
  network: z.boolean(),
  worktree: z.boolean(),
  docker: z.boolean().optional(),
  note: z.string().optional(),
});
export type SandboxCapabilities = z.infer<typeof SandboxCapabilitiesSchema>;

export const SandboxTestResultSchema = z.object({
  ok: z.boolean(),
  target: z.string(),
  mode: NetworkModeSchema,
  latencyMs: z.number().nonnegative().optional(),
  statusCode: z.number().int().optional(),
  blockedByRule: z.boolean().optional(),
  message: z.string(),
});
export type SandboxTestResult = z.infer<typeof SandboxTestResultSchema>;

export const TaskWorktreeStateSchema = z.enum(["active", "merged", "conflict", "discarded", "kept"]);
export type TaskWorktreeState = z.infer<typeof TaskWorktreeStateSchema>;

export const TaskWorktreeInfoSchema = z.object({
  state: TaskWorktreeStateSchema,
  branch: z.string().optional(),
  files: z.array(z.string()).optional(),
  message: z.string().optional(),
});
export type TaskWorktreeInfo = z.infer<typeof TaskWorktreeInfoSchema>;

/** 判断环境变量名是否属于敏感凭据（强制走 SecretStore，不落明文）。 */
export function isSensitiveEnvKey(key: string): boolean {
  return /secret|token|key|password|authorization|cookie/i.test(key);
}

/** 是否启用了需要子进程级环境变量或网络接入的沙箱配置。 */
export function hasActiveProcessSandboxOverrides(profile: AgentSandboxProfile): boolean {
  return (
    profile.backend.kind === "docker" ||
    profile.network.mode !== "inherit" ||
    profile.network.allowlist.length > 0 ||
    profile.network.denylist.length > 0 ||
    profile.network.auditOutbound === true ||
    (profile.network.caCertPath !== undefined && profile.network.caCertPath.trim() !== "") ||
    Object.keys(profile.env.set).length > 0 ||
    profile.env.secretKeys.length > 0 ||
    profile.env.unset.length > 0 ||
    profile.env.prependPath.length > 0 ||
    profile.env.isolatedHome
  );
}

/** 档案是否完全等于默认值（用于精简存储）。 */
export function isDefaultSandboxProfile(profile: AgentSandboxProfile): boolean {
  return (
    !hasActiveProcessSandboxOverrides(profile) &&
    profile.workspace.isolation === "shared" &&
    profile.network.noProxy.length === 0 &&
    (profile.network.proxyUrl === undefined || profile.network.proxyUrl.trim() === "")
  );
}

function normalizeHost(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end > 0) host = host.slice(1, end);
  }
  return host.replace(/\.+$/, "");
}

/**
 * 匹配主机名/域名模式：
 * - `*` 匹配全部
 * - `*.example.com` 匹配子域名及自身域（按常用 proxy/allowlist 习惯，不匹配 `badexample.com`）
 * - `.example.com` 匹配子域名及自身域
 * - `example.com` 精确匹配
 */
export function matchHostPattern(host: string, pattern: string): boolean {
  const normalizedHost = normalizeHost(host);
  const normalizedPattern = normalizeHost(pattern);
  if (normalizedHost === "" || normalizedPattern === "") return false;
  if (normalizedPattern === "*") return true;
  if (normalizedPattern.startsWith("*.")) {
    const suffix = normalizedPattern.slice(2);
    return suffix !== "" && (normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`));
  }
  if (normalizedPattern.startsWith(".")) {
    const suffix = normalizedPattern.slice(1);
    return suffix !== "" && (normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`));
  }
  return normalizedHost === normalizedPattern;
}
