/**
 * 子进程的唯一出口。遵循架构设计规范。
 *
 * 三条规矩只在这一个文件里实现，别处不再 spawn：
 * - `spawn` 直调可执行文件，`shell` 永远是 false
 * - `windowsHide: true`（打包版不弹黑框），prompt 一律走 stdin
 * - 终止用 `taskkill /T /F`（Windows）或 `process.kill(-pid)`（其它平台），成组收掉
 */

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** 单个流的输出上限：够放一次验证/JSON 输出，又不至于把内存撑爆。 */
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * 白名单构造：不把宿主的任意环境变量漏给执行者。
 *
 * 代理与自定义 CA 必须在里面：执行者都是要联网的 CLI，企业网络、内网镜像、
 * 自签证书这三类环境完全依赖这些变量。漏掉它们，子进程一律连不上网，
 * 报出来的却是"证书错误 / 连接失败"，排查时很难联想到是宿主没把变量传下去。
 */
const ENV_WHITELIST = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "ComSpec",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMDATA",
  "HOME",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "LANG",
  "LC_ALL",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  // 代理：大小写两种写法都要带，不同工具读的键名不一样。
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  // 自定义证书：Node、git、各家 CLI 各读各的。
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
];

export function sanitizedEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_WHITELIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

export interface SpawnSpec {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: SpawnOptions["stdio"];
}

/**
 * 真正要启动的命令。
 *
 * Windows 上的 `.cmd` / `.bat` 不是可执行文件，Node 22 起直接 spawn 会抛 `EINVAL`。
 * npm 全局安装的 CLI（claude、codex 等）在 Windows 上就是这种包装脚本，所以这一类
 * 必须交给 `cmd.exe /c` 启动；参数逐个加引号并整行交给 cmd，避免路径里的空格、
 * 中文、`&|<>` 被当成命令分隔符。
 *
 * 已知边界：cmd 会在启动前展开参数里的 `%VAR%`。各家的 prompt 都走 stdin，
 * 参数只有开关、模型名和路径，不会碰到；自定义命令的参数若含 `%`，用户需自行避开。
 */
export interface PreparedCommand {
  readonly bin: string;
  readonly args: string[];
  /** 命令行已经自己加好引号：必须原样交给 Windows，不让 Node 再转义一遍。 */
  readonly verbatim: boolean;
}

export function prepareCommand(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): PreparedCommand {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(bin)) {
    return { bin, args: [...args], verbatim: false };
  }
  const comspec =
    env["COMSPEC"] ?? env["ComSpec"] ?? `${env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows"}\\System32\\cmd.exe`;
  const quote = (value: string): string => `"${value.split('"').join('""')}"`;
  const line = `"${[bin, ...args].map(quote).join(" ")}"`;
  return { bin: comspec, args: ["/d", "/s", "/c", line], verbatim: true };
}

/** 直调可执行文件。`shell` 显式写 false：这是 C11 的检查点。 */
export function spawnChild(bin: string, args: readonly string[], spec: SpawnSpec): ChildProcess {
  const env = spec.env ?? sanitizedEnv();
  const prepared = prepareCommand(bin, args, env);
  return spawn(prepared.bin, prepared.args, {
    cwd: spec.cwd,
    stdio: spec.stdio ?? ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    shell: false,
    env,
    ...(prepared.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
}

/** 成组终止。Windows 上 `child.kill()` 只杀直接子进程，任务树会漏。 */
export function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      shell: false,
    });
    killer.on("error", () => {
      /* 进程可能已经自己退了 */
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* 同上 */
    }
  }
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  /**
   * 输出撞上了 maxOutputBytes：子进程已被终止，stdout/stderr 只有前半截。
   * 输出超限时会被标记为截断，调用方需据此判断是否需要报错或向用户说明。
   */
  readonly overflowed: boolean;
}

export interface RunOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** prompt / stdin 输入内容，通过标准输入传递以规避参数长度限制与泄露风险。 */
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** stdout 与 stderr 各自保留的字节上限。超过就终止子进程（默认 4 MiB）。 */
  readonly maxOutputBytes?: number;
  /** 进程还在跑时就把 stdout 片段交给调用方（流式输出用）；完整输出仍在结果里。 */
  readonly onStdout?: (chunk: string) => void;
  /** 输出来自系统命令行工具（where / reg），按控制台代码页解码，见 decodeConsoleOutput。 */
  readonly consoleEncoding?: boolean;
}

/**
 * 跑一个短命令并收全部输出。
 * 超时或取消都会成组终止；`timedOut` / `aborted` 由调用方决定是 failed 还是 unknown。
 */
export function runProcess(
  bin: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let timedOut = false;
    let aborted = false;
    let overflowed = false;
    let settled = false;
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const child = spawnChild(bin, args, { cwd: options.cwd, env: options.env ?? sanitizedEnv() });
    const out: Buffer[] = [];
    const stdoutDecoder = new StringDecoder("utf8");
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      const decode = options.consoleEncoding === true
        ? decodeConsoleOutput
        : (bytes: Buffer): string => bytes.toString("utf8");
      resolve({
        code,
        signal,
        stdout: decode(Buffer.concat(out)),
        stderr: decode(Buffer.concat(err)),
        durationMs: Date.now() - startedAt,
        timedOut,
        aborted,
        overflowed,
      });
    };

    /** 收一段输出：超上限就只留到上限，并终止子进程（此后不再往上加）。 */
    const collect = (target: Buffer[], chunk: Buffer, used: number): number => {
      if (overflowed) return used;
      const room = maxBytes - used;
      if (chunk.length >= room) {
        if (room > 0) target.push(chunk.subarray(0, room));
        overflowed = true;
        terminateProcessTree(child);
        return maxBytes;
      }
      target.push(chunk);
      return used + chunk.length;
    };

    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            terminateProcessTree(child);
          }, options.timeoutMs);
    timer?.unref();

    const onAbort = (): void => {
      aborted = true;
      terminateProcessTree(child);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      outBytes = collect(out, chunk, outBytes);
      // 用 StringDecoder：一个汉字的字节可能被拆在两个片段里，直接 toString 会出乱码。
      if (options.onStdout !== undefined) options.onStdout(stdoutDecoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      errBytes = collect(err, chunk, errBytes);
    });
    child.on("error", (error) => {
      err.push(Buffer.from(String(error)));
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      finish(null, null);
    });
    child.on("close", (code, signal) => {
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      finish(code, signal);
    });

    if (child.stdin !== null) {
      child.stdin.on("error", () => {
        /* 子进程可能先退出，写 stdin 会 EPIPE；错误已由 exit code 反映 */
      });
      if (options.input !== undefined) child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

/**
 * 解码 Windows 命令行工具的输出。
 *
 * `where`、`reg`、`chcp` 这些系统工具写的是控制台代码页（中文系统上是 936/GBK），
 * 不是 UTF-8。用 utf8 解码会把路径里的中文变成替换字符，`existsSync` 随后全部失败——
 * 表现就是"装在中文用户名或中文目录下的 Agent 探测不到"。
 * 只在这类工具的输出上做一次兜底：先按 UTF-8 严格解，失败再按 GBK 解。
 */
function decodeConsoleOutput(bytes: Buffer): string {
  if (process.platform !== "win32") return bytes.toString("utf8");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("gbk").decode(bytes);
    } catch {
      return bytes.toString("utf8");
    }
  }
}

/** 找不到可执行文件时的探测：path 上的 `which` 等价物。 */
export async function whichBinary(bin: string, cwd: string): Promise<string | null> {
  if (isAbsolute(bin)) {
    try { accessSync(bin, constants.X_OK); return bin; } catch { return null; }
  }
  const probe = process.platform === "win32" ? "where" : "which";
  const result = await runProcess(probe, [bin], { cwd, timeoutMs: 5000, consoleEncoding: true });
  if (result.code !== 0) return null;
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  if (process.platform !== "win32") return lines[0] ?? null;
  // `where npm` 会连着给出 `...\npm` 和 `...\npm.cmd`：前者是给 shell 用的无扩展名 shim，
  // 直接用 CreateProcess 启动它只会 ENOENT。按 PATHEXT 逐行补全，取第一个真的存在且能启动的。
  const exts = (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter((ext) => ext !== "");
  const candidates: string[] = [];
  for (const line of lines) {
    if (/\.[^\\/.]{1,4}$/.test(line) && existsSync(line)) {
      candidates.push(line);
      continue;
    }
    for (const ext of exts) {
      const withExt = `${line}${ext.toLowerCase()}`;
      if (existsSync(withExt)) candidates.push(withExt);
    }
  }
  // `.exe` 优先：包装脚本要多一层 cmd，能直调就直调。
  candidates.sort((left, right) => rank(left) - rank(right));
  return candidates[0] ?? (lines[0] ?? null);
}

function rank(path: string): number {
  if (/\.exe$/i.test(path)) return 0;
  if (/\.com$/i.test(path)) return 1;
  if (/\.(cmd|bat)$/i.test(path)) return 2;
  return 3;
}

/**
 * 启动一个与本进程脱钩的桌面应用（例如按需拉起 Kimi Code）。
 * 与 spawnChild 一样直调可执行文件、不经 shell；但不接管它的输入输出，也不随本进程退出而结束。
 *
 * 和 spawnChild 共用 prepareCommand：桌面版万一装成 `.cmd` 包装脚本，
 * 裸 spawn 会抛 EINVAL、错误又被下面的 on("error") 吞掉，表现成"等它启动、一直等不到"。
 */
export function launchDetached(bin: string, args: readonly string[] = []): void {
  const env = sanitizedEnv();
  const prepared = prepareCommand(bin, args, env);
  const child = spawn(prepared.bin, prepared.args, {
    detached: true,
    stdio: "ignore",
    shell: false,
    windowsHide: false,
    env,
    ...(prepared.verbatim ? { windowsVerbatimArguments: true } : {}),
  });
  child.on("error", () => {
    /* 启动失败由调用方的就绪轮询超时来报告 */
  });
  child.unref();
}

const uninstallCache = new Map<string, { at: number; exe: string | null }>();

/**
 * 从 Windows 卸载信息（HKCU / HKLM）里按显示名找已安装程序的可执行文件。
 *
 * 安装目录可由用户自选，不能写死路径；卸载信息里的 DisplayIcon 记的就是真实位置。
 * 同步实现：Agent 清单是同步构建的。结果缓存 60 秒，避免每次 RPC 都去查注册表。
 *
 * `exeName` 不一定就是 DisplayIcon 指的那个：OpenCode 的 ACP 入口 `opencode-acp.exe`
 * 和 Antigravity 的 `agy.exe` 都只是同一安装目录里的另一个文件。所以先精确匹配，
 * 再在 DisplayIcon 所在目录（及其子目录，限两层）里找同名文件。
 */
export function findInstalledExe(displayName: string, exeName: string): string | null {
  if (process.platform !== "win32") return null;
  const key = `${displayName}|${exeName}`;
  const cached = uninstallCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.exe;
  const target = exeName.toLowerCase();
  const roots: string[] = [];
  let found: string | null = null;
  for (const hive of ["HKCU", "HKLM"]) {
    const result = spawnSync(
      "reg",
      ["query", `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, "/s", "/f", displayName, "/d"],
      { windowsHide: true, shell: false, timeout: 10_000 },
    );
    // 注册表 key 名和值都是控制台代码页编码的：中文安装目录必须按 GBK 解，否则路径失效。
    const text = decodeConsoleOutput(result.stdout ?? Buffer.alloc(0));
    for (const line of text.split(/\r?\n/)) {
      // InstallLocation 是安装根目录，有些程序（Antigravity）把工具装在旁边而不是里面。
      const location = /InstallLocation\s+REG_(?:SZ|EXPAND_SZ)\s+"?([^",]+)/i.exec(line)?.[1]?.trim();
      if (location !== undefined && location !== "" && !roots.includes(location)) roots.push(location);
      const match = /DisplayIcon\s+REG_(?:SZ|EXPAND_SZ)\s+"?([^",]+)/i.exec(line);
      const candidate = match?.[1]?.trim();
      if (candidate === undefined) continue;
      if (candidate.toLowerCase().endsWith(target) && existsSync(candidate)) {
        found = candidate;
        break;
      }
      // 记下可能的安装目录，稍后再找同名文件。
      const dir = dirname(candidate);
      if (!roots.includes(dir)) roots.push(dir);
    }
    if (found !== null) break;
  }
  if (found === null) {
    for (const root of roots) {
      found = findInTree(root, exeName, 2);
      if (found !== null) break;
    }
  }
  uninstallCache.set(key, { at: Date.now(), exe: found });
  return found;
}

/** 在目录里按文件名找可执行文件，最多往下 `depth` 层。 */
function findInTree(root: string, exeName: string, depth: number): string | null {
  const direct = join(root, exeName);
  if (existsSync(direct)) return direct;
  if (depth <= 0) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const child = join(root, entry);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    const hit = findInTree(child, exeName, depth - 1);
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * 进程的启动时间（毫秒时间戳），查不到返回 null。
 * 用来识别进程号复用：Windows 会把已退出进程的号很快分给别的进程。
 */
export function processStartedAt(pid: number): number | null {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
    { encoding: "utf8", windowsHide: true, shell: false, timeout: 10_000 },
  );
  if (result.status !== 0) return null;
  const at = Date.parse((result.stdout ?? "").trim());
  return Number.isNaN(at) ? null : at;
}
