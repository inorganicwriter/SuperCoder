/**
 * Docker 容器运行时纯命令与临时环境文件构建器。
 *
 * 注意：此模块不引入 `node:child_process`，所有进程启动与回收均统一走 `exec.ts`。
 * 所有环境变量与敏感凭据一律写入权限为 `0o600` 的临时 `--env-file`，
 * 绝不作为 `-e KEY=VAL` 出现在命令行参数中。
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerBackendConfig } from "../../shared/domain/sandbox.js";

export interface DockerAvailability {
  readonly available: boolean;
  readonly version?: string;
  readonly reason?: string;
}

export interface DockerRunSpec extends DockerBackendConfig {
  /** 只读任务或探测操作时以 `:ro` 挂载工作区，内核级禁止写入。 */
  readonly workspaceReadOnly?: boolean;
  /** 关联当前 SuperCoder 数据目录的实例标签，仅清理归属本实例的容器。 */
  readonly ownerTag?: string;
}

export const SUPER_DOCKER_MANAGED_LABEL = "supercoder.managed=true";
export const DOCKER_OWNER_LABEL_KEY = "supercoder.owner";

export interface DockerRunPlanInput {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly docker: DockerRunSpec;
  readonly containerName?: string;
  readonly containerWorkdir?: string;
}

export interface DockerRunPlan {
  readonly bin: "docker";
  readonly args: string[];
  readonly containerName: string;
  readonly envFilePath: string;
  readonly dispose: () => void;
}

export function createDockerContainerName(prefix = "sc"): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

/** 将宿主机二进制路径解析为容器内可执行命令或路径。 */
export function resolveContainerBinary(bin: string): string {
  const trimmed = bin.trim();
  if (trimmed === "") return trimmed;
  if (trimmed.startsWith("/")) return trimmed;
  let candidate = trimmed;
  if (candidate.includes("\\") || /^[A-Za-z]:/.test(candidate)) {
    const parts = candidate.split(/[\\/]+/).filter((part) => part !== "");
    candidate = parts.at(-1) ?? candidate;
  }
  return candidate.replace(/\.(exe|cmd|bat)$/i, "");
}

/** 将指向宿主机回环地址的 URL（代理或本地模型端点）改写为容器内可访问的 `host.docker.internal`。 */
export function rewriteLoopbackUrlForDocker(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed === "") return trimmed;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
      parsed.hostname = "host.docker.internal";
      const out = parsed.toString();
      return parsed.pathname === "/" && parsed.search === "" && parsed.hash === "" && !trimmed.endsWith("/")
        ? out.slice(0, -1)
        : out;
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

export const rewriteProxyUrlForDocker = rewriteLoopbackUrlForDocker;

function serializeEnvFile(env: Readonly<Record<string, string | undefined>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "" || key.includes("=") || /[\r\n]/.test(key)) continue;
    const sanitizedValue = value.replace(/[\r\n]+/g, " ");
    lines.push(`${key}=${sanitizedValue}`);
  }
  return lines.join("\n");
}

export function buildDockerRunPlan(input: DockerRunPlanInput): DockerRunPlan {
  const image = input.docker.image.trim();
  if (image === "") {
    throw new Error("Docker 镜像名称不能为空");
  }
  const containerName = input.containerName ?? createDockerContainerName();
  const workdir = input.containerWorkdir ?? "/workspace";

  const envDir = mkdtempSync(join(tmpdir(), "sc-docker-env-"));
  const envFilePath = join(envDir, "env.list");
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      rmSync(envDir, { recursive: true, force: true });
    } catch {
      /* 忽略临时目录清理异常 */
    }
  };

  try {
    writeFileSync(envFilePath, serializeEnvFile(input.env), { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    dispose();
    throw error;
  }

  const workspaceMount =
    input.docker.workspaceReadOnly === true
      ? `${input.cwd}:${workdir}:ro`
      : `${input.cwd}:${workdir}`;

  const args: string[] = [
    "run",
    "--rm",
    "-i",
    "--init",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true",
    "--pids-limit=512",
    "--label",
    SUPER_DOCKER_MANAGED_LABEL,
    ...(input.docker.ownerTag !== undefined && input.docker.ownerTag.trim() !== ""
      ? ["--label", `${DOCKER_OWNER_LABEL_KEY}=${input.docker.ownerTag.trim()}`]
      : []),
    "--name",
    containerName,
    "--workdir",
    workdir,
    "-v",
    workspaceMount,
  ];

  if (input.docker.networkIsolation === "none") {
    args.push("--network", "none");
  } else if (input.docker.networkIsolation === "proxy-only") {
    // 禁用容器直连外部 DNS，结合 host.docker.internal 代理网关收敛流量。
    args.push("--network", "bridge", "--add-host=host.docker.internal:host-gateway", "--dns=127.0.0.1");
  } else {
    args.push("--network", "bridge", "--add-host=host.docker.internal:host-gateway");
  }

  if (input.docker.memoryLimit !== undefined && input.docker.memoryLimit.trim() !== "") {
    args.push("--memory", input.docker.memoryLimit.trim());
  }
  if (input.docker.cpuLimit !== undefined) {
    args.push("--cpus", String(input.docker.cpuLimit));
  }
  if (input.docker.readOnlyRoot) {
    args.push("--read-only", "--tmpfs", "/tmp:rw,nosuid,size=256m");
  }

  for (const mount of input.docker.extraMounts) {
    const hostPath = mount.host.trim();
    const containerPath = mount.container.trim();
    if (hostPath === "" || containerPath === "") continue;
    args.push("-v", `${hostPath}:${containerPath}:${mount.readOnly ? "ro" : "rw"}`);
  }

  args.push("--env-file", envFilePath, image, resolveContainerBinary(input.bin), ...input.args);

  return {
    bin: "docker",
    args,
    containerName,
    envFilePath,
    dispose,
  };
}

/** 清理崩溃遗留的 `sc-docker-env-*` 临时目录；默认仅清超过 1 小时的陈旧目录，永不抛异常。 */
export function cleanupStaleDockerEnvDirs(options?: {
  readonly rootDir?: string;
  readonly maxAgeMs?: number;
  readonly now?: number;
}): number {
  const rootDir = options?.rootDir ?? tmpdir();
  const maxAgeMs = options?.maxAgeMs ?? 60 * 60 * 1000;
  const now = options?.now ?? Date.now();
  let removed = 0;
  try {
    const entries = readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("sc-docker-env-")) continue;
      const fullPath = join(rootDir, entry.name);
      try {
        const mtimeMs = statSync(fullPath).mtimeMs;
        if (now - mtimeMs < maxAgeMs) continue;
        rmSync(fullPath, { recursive: true, force: true });
        removed += 1;
      } catch {
        /* 忽略单个临时目录无权限或已被并发删除的情况 */
      }
    }
  } catch {
    return removed;
  }
  return removed;
}
