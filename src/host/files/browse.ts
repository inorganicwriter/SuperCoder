/**
 * 文件栏的服务端部分：列目录、读文件、看 git 状态。**只读**，一行写操作都没有。
 *
 * 路径一律先过 `resolveInsideRoot`：`../` 与符号链接都要能被挡回去。
 * 这是给界面看的，不是给模型用的工具，所以没有命令行、没有编辑、没有删除。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { runProcess } from "../boot/exec.js";
import { messageOf } from "../boot/failure.js";
import { isGitRepo } from "../workspace/git.js";
import { resolveInsideRoot } from "../workspace/entity.js";

/** 不列这些目录：要么是工具自己维护的，要么列出来就是几万条。 */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "release", "build", "lib", "lib-electron"]);

/** 单次列目录的上限，超了就截断并在结果里说明。 */
const MAX_ENTRIES = 800;

/** 预览上限 512KB：再大就不是"看一眼"而是"打开"了。 */
const MAX_PREVIEW_BYTES = 512 * 1024;

export interface FileEntry {
  readonly name: string;
  /** 相对工作区根的路径，分隔符统一成 `/`。 */
  readonly path: string;
  readonly kind: "dir" | "file";
  readonly size: number;
}

export interface DirectoryListing {
  readonly path: string;
  readonly entries: FileEntry[];
  readonly truncated: boolean;
}

export interface FilePreview {
  readonly path: string;
  readonly size: number;
  readonly content: string;
  /** 超过上限只给前 512KB。 */
  readonly truncated: boolean;
  /** 二进制文件不给内容，只给大小。 */
  readonly binary: boolean;
}

export interface GitChange {
  readonly path: string;
  /** porcelain 的两列状态，压成一个字母：M/A/D/R/??/U。 */
  readonly status: string;
}

export interface GitSummary {
  readonly isRepo: boolean;
  readonly branch: string;
  readonly changes: GitChange[];
  /** git 不可用或超时时的说明；非空表示这次没读到状态。 */
  readonly error: string | null;
}

/** 把 `a/b` 这类相对路径规整一下，挡住绝对路径与空段。 */
function normalizeRelative(input: string): string {
  return input
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/** 列一个目录。失败时抛中文错误，末尾带下一步。 */
export function listDirectory(root: string, rawPath: string): DirectoryListing {
  const relativePath = normalizeRelative(rawPath);
  const resolved = resolveInsideRoot(root, relativePath);
  if (!resolved.ok) throw new Error(resolved.error);
  let stat;
  try {
    stat = statSync(resolved.value);
  } catch (error) {
    throw new Error(`无法读取目录：${messageOf(error)}`);
  }
  if (!stat.isDirectory()) {
    throw new Error("目标路径不是目录");
  }
  let names: string[];
  try {
    names = readdirSync(resolved.value);
  } catch (error) {
    throw new Error(`获取目录列表失败：${messageOf(error)}`);
  }
  const entries: FileEntry[] = [];
  for (const name of names) {
    if (entries.length >= MAX_ENTRIES) break;
    if (SKIP_DIRS.has(name)) continue;
    const childRelative = relativePath === "" ? name : `${relativePath}/${name}`;
    let childStat;
    try {
      childStat = statSync(join(resolved.value, name));
    } catch {
      continue;
    }
    if (childStat.isDirectory()) {
      entries.push({ name, path: childRelative, kind: "dir", size: 0 });
      continue;
    }
    if (!childStat.isFile()) continue;
    entries.push({ name, path: childRelative, kind: "file", size: childStat.size });
  }
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    return left.name.localeCompare(right.name, "zh-CN");
  });
  return { path: relativePath, entries, truncated: names.length > entries.length };
}

/** 读一个文本文件用于预览。二进制与超大文件都给可读的说明，不硬塞内容。 */
export function readPreview(root: string, rawPath: string): FilePreview {
  const relativePath = normalizeRelative(rawPath);
  if (relativePath === "") {
    throw new Error("未指定有效文件路径");
  }
  const resolved = resolveInsideRoot(root, relativePath);
  if (!resolved.ok) throw new Error(resolved.error);
  let stat;
  try {
    stat = statSync(resolved.value);
  } catch (error) {
    throw new Error(`无法读取文件：${messageOf(error)}`);
  }
  if (!stat.isFile()) throw new Error("目标路径不是普通文件");
  if (extname(relativePath).toLowerCase() === ".svg") {
    // SVG 是文本，照读；这里留着分支是为了说明"没有特例"。
  }
  const head = readFileSync(resolved.value);
  const truncated = head.length > MAX_PREVIEW_BYTES;
  const slice = truncated ? head.subarray(0, MAX_PREVIEW_BYTES) : head;
  const binary = slice.includes(0);
  return {
    path: relativePath,
    size: stat.size,
    content: binary ? "" : slice.toString("utf8"),
    truncated,
    binary,
  };
}

/** git 分支与变更清单。不是仓库时如实说，不假装是空变更。 */
export async function gitSummary(root: string): Promise<GitSummary> {
  if (!isGitRepo(root)) {
    return { isRepo: false, branch: "", changes: [], error: null };
  }
  const branch = await runProcess("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    timeoutMs: 10_000,
  });
  const status = await runProcess("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 20_000 });
  if (status.code !== 0) {
    return {
      isRepo: true,
      branch: "",
      changes: [],
      error: `git status 执行失败（退出码 ${String(status.code)}）：${status.stderr.trim()}`,
    };
  }
  const changes: GitChange[] = [];
  for (const line of status.stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const code = line.slice(0, 2).trim();
    const path = line.slice(3).trim();
    if (path === "") continue;
    changes.push({ path: path.replace(/\\/g, "/"), status: code === "" ? "?" : code });
  }
  return {
    isRepo: true,
    branch: branch.code === 0 ? branch.stdout.trim() : "",
    changes,
    error: null,
  };
}
