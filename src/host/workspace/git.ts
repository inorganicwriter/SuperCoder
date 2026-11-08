/**
 * 回撤的落地动作。遵循架构设计规范。
 *
 * 新行为：回撤一律走 `git checkout -- <paths>`，工作区不是 git 仓库时
 * 提示用户并中止回撤，避免在非版本受控目录下进行不可靠的文件恢复。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../../shared/result.js";
import { runProcess } from "../boot/exec.js";

export interface GitCheckoutResult {
  readonly restored: string[];
}

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git"));
}

/** 变更检测用 `git status --porcelain`。 */
export async function gitStatusPorcelain(root: string): Promise<Result<string, string>> {
  if (!isGitRepo(root)) {
    return err("当前工作区未初始化 Git 仓库，无法用 Git 获取变更状态。");
  }
  const result = await runProcess("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 20_000 });
  if (result.code !== 0) {
    return err(`git status 失败（退出码 ${String(result.code)}）：${result.stderr.trim()}`);
  }
  return ok(result.stdout);
}

/**
 * 用 git 把给定路径恢复到 HEAD。
 *
 * 空数组是合法输入：没有文件要恢复时不调用 git，直接返回成功。
 */
export async function restoreFiles(
  root: string,
  paths: readonly string[],
): Promise<Result<GitCheckoutResult, string>> {
  const unique = [...new Set(paths.filter((path) => path !== ""))];
  // 没有文件要恢复时不碰 git：工作区是不是仓库都无所谓。
  if (unique.length === 0) return ok({ restored: [] });
  if (!isGitRepo(root)) {
    return err(
      "当前工作区未初始化 Git 仓库，无法执行回撤。请在该目录运行 git init 并提交基线修改后再试。",
    );
  }
  // 分批，避免命令行长度上限（Windows 32767）。
  const batchSize = 80;
  for (let offset = 0; offset < unique.length; offset += batchSize) {
    const batch = unique.slice(offset, offset + batchSize);
    const result = await runProcess("git", ["checkout", "--", ...batch], {
      cwd: root,
      timeoutMs: 60_000,
    });
    if (result.code !== 0) {
      return err(
        `git checkout 失败（退出码 ${String(result.code)}）：${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }
  return ok({ restored: unique });
}
