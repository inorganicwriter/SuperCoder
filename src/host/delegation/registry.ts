/**
 * 执行者清单：谁参与四级阶梯、各自的私有存储在哪儿。
 *
 * 这一份是"配置"，不含逻辑；探测与任务分派的判断全在 ProviderSelect 与各 provider 里。
 */

import { dirname, join } from "node:path";
import { findInstalledExe } from "../boot/exec.js";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { CustomAgentSchema } from "../../shared/domain/custom-agent.js";
import { AcpProvider, type AcpDeps } from "./providers/acp.js";
import { CliJsonProvider } from "./providers/cli-json.js";
import { CodexAppServerProvider } from "./providers/codex-appserver.js";
import { JsonlStoreProbe } from "./providers/store-probe.js";
import { CommandProvider } from "./providers/command.js";
import { ClaudeCodeProvider } from "./providers/claude-code.js";
import { KimiStoreProbe } from "./providers/kimi-store.js";
import { KimiCodeProvider } from "./providers/kimi.js";
import { OpenCodeDesktopProvider } from "./providers/opencode-desktop.js";
import type { FamilySpec } from "./provider-select.js";

export interface FamilyOptions {
  readonly homeDir: string;
  readonly configFile?: string;
  readonly allowPermissions?: (agentId: string) => boolean;
  /** 测试注入：替代注册表查询。 */
  readonly findInstalled?: (displayName: string, exeName: string) => string | null;
}

export const CustomAgentsSchema = z.object({ agents: z.array(CustomAgentSchema.passthrough()).default([]) }).passthrough();

export function createProviderFamilies(options: FamilyOptions): FamilySpec[] {
  const acp = (deps: AcpDeps): AcpProvider => new AcpProvider({ ...deps, allowPermissions: () => options.allowPermissions?.(deps.providerId ?? "acp") === true });
  const findInstalled = options.findInstalled ?? findInstalledExe;
  // 安装目录可自选：先看卸载信息里登记的真实位置，再退回默认安装目录。不写死某台机器的路径。
  const registered = findInstalled("DeepSeek Harness", "DeepSeek Harness.exe");
  const harnessRoots = [
    ...(registered === null ? [] : [dirname(registered)]),
    join(options.homeDir, "AppData", "Local", "Programs", "DeepSeek Harness"),
  ];
  const detectedHarnessRoot = harnessRoots.find((root) => existsSync(join(root, "DeepSeek Harness.exe")) && existsSync(join(root, "resources", "app.asar")) && existsSync(join(root, "resources", "runtime", "cli", "bin", "dsh.cmd")));
  const harnessRoot = detectedHarnessRoot ?? harnessRoots[0]!;
  const harnessCli = join(harnessRoot, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
  const codexProbe = new JsonlStoreProbe("codex", {
    roots: { codex: [join(options.homeDir, ".codex", "sessions")] },
    homeDir: options.homeDir,
  });
  const opencodeProbe = new JsonlStoreProbe("opencode", {
    roots: {
      opencode: [
        join(options.homeDir, ".local", "share", "opencode"),
        join(options.homeDir, ".opencode"),
      ],
    },
    homeDir: options.homeDir,
  });
  const antigravityProbe = new JsonlStoreProbe("antigravity", {
    // Neither directory alone proves that readable Antigravity sessions exist.
    roots: { antigravity: [] },
    homeDir: options.homeDir,
  });
  const claudeProbe = new JsonlStoreProbe("claude-code", {
    roots: { "claude-code": [join(options.homeDir, ".claude", "projects")] },
    homeDir: options.homeDir,
  });
  const kimiProbe = new KimiStoreProbe({
    sessionsDir: join(options.homeDir, ".kimi-code", "sessions"),
  });

  // OpenCode 的 ACP 入口跟着桌面版走：先问卸载信息，再退回默认安装目录。
  // 写死默认目录的话，装在别的盘（例如 D:\Tools\OpenCode）或换用户名就一律扫不到。
  const opencodeAidep = findInstalled("OpenCode", "opencode-acp.exe") ?? join(options.homeDir, "AppData", "Local", "Programs", "@opencode-aidesktop", "opencode-acp.exe");
  // Antigravity 的 ACP 是 agy.exe，位置随版本变化：同样先查卸载信息。
  const agyExe = findInstalled("Antigravity", "agy.exe") ?? join(options.homeDir, "AppData", "Local", "agy", "bin", "agy.exe");

  const families: FamilySpec[] = [
    {
      id: "codex",
      label: "Codex",
      entries: [
        { level: 1, provider: new CodexAppServerProvider({ allowPermissions: () => options.allowPermissions?.("codex") === true }) },
        { level: 2, provider: new CliJsonProvider() },
      ],
      probe: codexProbe,
    },
    {
      id: "opencode",
      label: "OpenCode",
      entries: [
        { level: 1, provider: new OpenCodeDesktopProvider({ homeDir: options.homeDir }) },
        { level: 3, provider: acp({ providerId: "opencode", binary: opencodeAidep, args: ["acp"] }) },
        {
          level: 3,
          provider: acp({ providerId: "opencode", binary: "opencode", args: ["acp"] }),
        },
      ],
      probe: opencodeProbe,
    },
    {
      id: "antigravity",
      label: "Antigravity",
      entries: [
        {
          level: 3,
          provider: acp({ providerId: "antigravity", binary: agyExe, args: ["acp"] }),
        },
        {
          level: 3,
          provider: acp({ providerId: "antigravity", binary: "agy", args: ["acp"] }),
        },
      ],
      probe: antigravityProbe,
    },
    {
      id: "deepseek-harness",
      label: "DeepSeek Harness",
      entries: [{ level: 3, provider: acp({ providerId: "deepseek-harness", binary: join(harnessRoot, "DeepSeek Harness.exe"), args: ["--expose-internals", harnessCli, "acp"], env: { ELECTRON_RUN_AS_NODE: "1", ...(process.env["DSH_HOME"] ? { DSH_HOME: process.env["DSH_HOME"] } : {}) }, detect: async () => detectedHarnessRoot ? { installed: true, binaryPath: join(detectedHarnessRoot, "DeepSeek Harness.exe") } : { installed: false, reason: "未找到支持 ACP 的 DeepSeek Harness 安装" } }) }],
      probe: new JsonlStoreProbe("deepseek-harness", { roots: {}, homeDir: options.homeDir }),
    },
    {
      id: "claude-code",
      label: "Claude Code",
      entries: [{ level: 2, provider: new ClaudeCodeProvider() }],
      probe: claudeProbe,
    },
    {
      id: "kimi-code",
      label: "Kimi Code",
      // 桌面版暴露本地 REST 服务（/api/v1），能任务分派；服务没起来时退回只读历史。
      entries: [{ level: 1, provider: new KimiCodeProvider({ homeDir: options.homeDir }) }],
      probe: kimiProbe,
    },
  ];
  if (options.configFile !== undefined && existsSync(options.configFile)) {
    const config = CustomAgentsSchema.parse(JSON.parse(readFileSync(options.configFile, "utf8")) as unknown);
    for (const agent of config.agents) {
      if (!agent.enabled) continue;
      if (families.some((family) => family.id === agent.id)) throw new Error(`Agent ID 重复：${agent.id}`);
      families.push({ id: agent.id, label: agent.label,
        entries: [{ level: 3, provider: agent.protocol === "acp" ? acp({ providerId: agent.id, binary: agent.binary, args: agent.args }) : new CommandProvider(agent.id, agent.binary, agent.args) }],
        probe: new JsonlStoreProbe(agent.id, { roots: {}, homeDir: options.homeDir }),
      });
    }
  }
  return families;
}
