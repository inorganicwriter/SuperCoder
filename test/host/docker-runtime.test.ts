/**
 * Docker 容器运行时命令行与 --env-file 安全构建测试（无需本机运行 Docker 守护进程）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DOCKER_OWNER_LABEL_KEY,
  SUPER_DOCKER_MANAGED_LABEL,
  buildDockerRunPlan,
  cleanupStaleDockerEnvDirs,
  resolveContainerBinary,
  rewriteLoopbackUrlForDocker,
  rewriteProxyUrlForDocker,
} from "../../src/host/boot/docker-runtime.js";
import { inspectDockerImage } from "../../src/host/boot/exec.js";
import { DockerBackendConfigSchema } from "../../src/shared/domain/sandbox.js";

const disposables: Array<() => void> = [];

afterEach(() => {
  while (disposables.length > 0) {
    disposables.pop()!();
  }
});

describe("Docker runtime builder", () => {
  it("normalizes host binary names and rewrites loopback proxy URLs for containers", () => {
    expect(resolveContainerBinary("C:\\Users\\demo\\AppData\\Roaming\\npm\\codex.cmd")).toBe("codex");
    expect(resolveContainerBinary("claude.exe")).toBe("claude");
    expect(resolveContainerBinary("/usr/local/bin/opencode")).toBe("/usr/local/bin/opencode");

    expect(rewriteProxyUrlForDocker("http://127.0.0.1:7890")).toBe("http://host.docker.internal:7890");
    expect(rewriteProxyUrlForDocker("http://codex:tok@localhost:9123")).toBe(
      "http://codex:tok@host.docker.internal:9123",
    );
    expect(rewriteProxyUrlForDocker("http://[::1]:8080")).toBe("http://host.docker.internal:8080");
    expect(rewriteProxyUrlForDocker("https://proxy.corp.example:8443")).toBe(
      "https://proxy.corp.example:8443",
    );
    expect(rewriteLoopbackUrlForDocker("http://127.0.0.1:11434/v1")).toBe(
      "http://host.docker.internal:11434/v1",
    );
    expect(rewriteLoopbackUrlForDocker("http://localhost:8000/v1/")).toBe(
      "http://host.docker.internal:8000/v1/",
    );
  });

  it("writes secrets only to 0600 env-file and builds isolated proxy-only docker run args", () => {
    const plan = buildDockerRunPlan({
      bin: "C:\\Tools\\claude.cmd",
      args: ["-p", "--output-format", "stream-json"],
      cwd: "D:\\Repo\\MyProject",
      env: {
        HTTP_PROXY: "http://claude-code:tok@host.docker.internal:18080",
        API_SECRET: "super-secret-value\nINJECTED=bad",
      },
      docker: {
        ...DockerBackendConfigSchema.parse({
          image: "ghcr.io/example/agent:latest",
          networkIsolation: "proxy-only",
          memoryLimit: "2g",
          cpuLimit: 2,
          readOnlyRoot: true,
          extraMounts: [{ host: "/host/cache", container: "/mnt/cache", readOnly: true }],
        }),
        workspaceReadOnly: true,
        ownerTag: "owner123",
      },
      containerName: "sc-test-1",
    });
    disposables.push(plan.dispose);

    expect(plan.bin).toBe("docker");
    expect(plan.args).toContain("--rm");
    expect(plan.args).toContain("--init");
    expect(plan.args).toContain("--cap-drop=ALL");
    expect(plan.args).toContain("--security-opt=no-new-privileges:true");
    expect(plan.args).toContain("--pids-limit=512");
    expect(plan.args).toContain(SUPER_DOCKER_MANAGED_LABEL);
    expect(plan.args).toContain(`${DOCKER_OWNER_LABEL_KEY}=owner123`);
    expect(plan.args).toContain("--name");
    expect(plan.args).toContain("sc-test-1");
    expect(plan.args).toContain("--workdir");
    expect(plan.args).toContain("/workspace");
    expect(plan.args).toContain("D:\\Repo\\MyProject:/workspace:ro");
    expect(plan.args).toContain("--network");
    expect(plan.args).toContain("bridge");
    expect(plan.args).toContain("--add-host=host.docker.internal:host-gateway");
    expect(plan.args).toContain("--dns=127.0.0.1");
    expect(plan.args).toContain("--memory");
    expect(plan.args).toContain("2g");
    expect(plan.args).toContain("--cpus");
    expect(plan.args).toContain("2");
    expect(plan.args).toContain("--read-only");
    expect(plan.args).toContain("--tmpfs");
    expect(plan.args).toContain("/host/cache:/mnt/cache:ro");
    expect(plan.args).toContain("--env-file");
    expect(plan.args).toContain(plan.envFilePath);

    // 密钥绝不能出现在 CLI 参数中
    const joinedArgs = plan.args.join(" ");
    expect(joinedArgs).not.toContain("super-secret-value");
    expect(joinedArgs).not.toContain("API_SECRET=");

    // 命令末尾是 mirror + binary + args
    const imageIdx = plan.args.indexOf("ghcr.io/example/agent:latest");
    expect(plan.args.slice(imageIdx)).toEqual([
      "ghcr.io/example/agent:latest",
      "claude",
      "-p",
      "--output-format",
      "stream-json",
    ]);

    expect(existsSync(plan.envFilePath)).toBe(true);
    const envContent = readFileSync(plan.envFilePath, "utf8");
    expect(envContent).toContain("HTTP_PROXY=http://claude-code:tok@host.docker.internal:18080");
    expect(envContent).toContain("API_SECRET=super-secret-value INJECTED=bad");
    expect(envContent).not.toContain("\nINJECTED=bad");

    plan.dispose();
    expect(existsSync(plan.envFilePath)).toBe(false);
  });

  it("supports bridge and none network modes cleanly", () => {
    const nonePlan = buildDockerRunPlan({
      bin: "codex",
      args: ["app-server"],
      cwd: "/repo",
      env: {},
      docker: DockerBackendConfigSchema.parse({
        image: "codex:1",
        networkIsolation: "none",
      }),
    });
    disposables.push(nonePlan.dispose);
    expect(nonePlan.args).toContain("--network");
    expect(nonePlan.args).toContain("none");
    expect(nonePlan.args).not.toContain("--dns=127.0.0.1");

    const bridgePlan = buildDockerRunPlan({
      bin: "opencode",
      args: ["acp"],
      cwd: "/repo",
      env: {},
      docker: DockerBackendConfigSchema.parse({
        image: "opencode:1",
        networkIsolation: "bridge",
      }),
    });
    disposables.push(bridgePlan.dispose);
    expect(bridgePlan.args).toContain("/repo:/workspace");
    expect(bridgePlan.args).toContain("bridge");
    expect(bridgePlan.args).toContain("--add-host=host.docker.internal:host-gateway");
    expect(bridgePlan.args).not.toContain("--dns=127.0.0.1");
  });

  it("handles empty image inspection safely without throwing", async () => {
    const emptyRes = await inspectDockerImage("   ");
    expect(emptyRes.exists).toBe(false);
    expect(emptyRes.reason).toBeTruthy();
  });

  it("removes stale sc-docker-env-* directories without touching fresh or unrelated dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-env-clean-"));
    disposables.push(() => rmSync(root, { recursive: true, force: true }));

    const oldDir = join(root, "sc-docker-env-old");
    const freshDir = join(root, "sc-docker-env-new");
    const otherDir = join(root, "other-dir");
    mkdirSync(oldDir);
    mkdirSync(freshDir);
    mkdirSync(otherDir);
    writeFileSync(join(oldDir, "env.list"), "SECRET=1", "utf8");

    const now = Date.now();
    const past = new Date(now - 2 * 60 * 60 * 1000);
    utimesSync(oldDir, past, past);
    utimesSync(otherDir, past, past);

    const removed = cleanupStaleDockerEnvDirs({ rootDir: root, maxAgeMs: 60 * 60 * 1000, now });
    expect(removed).toBe(1);
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(freshDir)).toBe(true);
    expect(existsSync(otherDir)).toBe(true);
  });
});
