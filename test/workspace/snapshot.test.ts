/**
 * 工作区快照的边界。遵循架构设计规范。
 *
 * 两个"悄悄少列"的问题：
 * 1. 跳过目录里除了 .git / node_modules / .pnpm-store，还塞了本仓库自己的构建产物
 *    （lib、lib-electron、lib-scripts、dist）。用户工作区里叫 dist 的源码目录
 *    （前端产物、Python 包）会被误跳过：快照缺文件 → 回撤不还原它们。
 * 2. 文件数超过 maxFiles 时 walk 直接 return，快照"看起来成功"但少列了尾巴，
 *    回撤因此漏还原 —— 属于内容被静默截断，必须显式失败。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotWorkspace, toPosixPath } from "../../src/host/workspace/snapshot.js";
import { isRpcFailure } from "../../src/host/boot/failure.js";
import { makeTempHome } from "../helpers/temp.js";

function touch(root: string, relativePath: string): void {
  const full = join(root, ...relativePath.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "x", "utf8");
}

function pathsOf(root: string, options = {}): string[] {
  return snapshotWorkspace(root, options).files.map((file) => file.path).sort();
}

describe("Workspace Snapshot Directory Filtering", () => {
  it("skips VCS and dependency directories while including custom build directories", () => {
    const temp = makeTempHome();
    try {
      touch(temp.home, "src/a.ts");
      touch(temp.home, "dist/bundle.js");
      touch(temp.home, "lib/index.js");
      touch(temp.home, "lib-electron/main.cjs");
      touch(temp.home, "lib-scripts/gen.js");
      touch(temp.home, ".git/config");
      touch(temp.home, "node_modules/pkg/index.js");
      touch(temp.home, ".pnpm-store/v3/x");

      const listed = pathsOf(temp.home);
      expect(listed).toEqual([
        "dist/bundle.js",
        "lib-electron/main.cjs",
        "lib-scripts/gen.js",
        "lib/index.js",
        "src/a.ts",
      ].sort());
      expect(listed).not.toContain(".git/config");
      expect(listed).not.toContain("node_modules/pkg/index.js");
      expect(listed).not.toContain(".pnpm-store/v3/x");
    } finally {
      temp.cleanup();
    }
  });

  it("allows overriding skipDirs for custom test fixtures", () => {
    const temp = makeTempHome();
    try {
      touch(temp.home, "src/a.ts");
      touch(temp.home, "dist/bundle.js");
      const listed = pathsOf(temp.home, { skipDirs: new Set(["dist"]) });
      expect(listed).toEqual(["src/a.ts"]);
    } finally {
      temp.cleanup();
    }
  });
});

describe("Workspace Snapshot File Count Limit", () => {
  it("fails explicitly when file count exceeds maxFiles threshold", () => {
    const temp = makeTempHome();
    try {
      for (let index = 0; index < 5; index += 1) touch(temp.home, `src/f${String(index)}.ts`);
      let caught: unknown = null;
      try {
        snapshotWorkspace(temp.home, { maxFiles: 3 });
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeNull();
      expect(isRpcFailure(caught)).toBe(true);
      if (isRpcFailure(caught)) {
        expect(caught.code).toBe("storage_failed");
        // 报错要说出上限数字。
        expect(caught.message).toContain("3");
        expect(caught.message).toContain("快照上限");
      }
    } finally {
      temp.cleanup();
    }
  });

  it("returns all files when total count is within limits", () => {
    const temp = makeTempHome();
    try {
      for (let index = 0; index < 3; index += 1) touch(temp.home, `src/f${String(index)}.ts`);
      const snapshot = snapshotWorkspace(temp.home, { maxFiles: 3 });
      expect(snapshot.files).toHaveLength(3);
      expect(snapshot.root).toBe(temp.home);
      expect(snapshot.takenAt.length).toBeGreaterThan(0);
    } finally {
      temp.cleanup();
    }
  });
});

describe("Path Formatting Style", () => {
  it("normalizes relative paths using forward slashes", () => {
    expect(toPosixPath("a/b/c")).toBe("a/b/c");
  });
});
