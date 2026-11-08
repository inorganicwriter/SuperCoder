/**
 * 文件浏览服务：只读访问、边界越界校验与隐藏工具目录过滤。
 *
 * 这三条是权限边界，不是功能细节：一旦 `../` 能读，整个 home 都暴露给渲染进程了。
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitSummary, listDirectory, readPreview } from "../../src/host/files/browse.js";

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sc-browse-"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# demo\n");
  writeFileSync(join(root, "src", "main.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src", "nested", "deep.ts"), "export const b = 2;\n");
  writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  return root;
}

describe("List Directory", () => {
  it("sorts directories before files with paths relative to workspace root", () => {
    const listing = listDirectory(makeRoot(), "");
    expect(listing.entries[0]?.kind).toBe("dir");
    expect(listing.entries.map((entry) => entry.name)).toContain("README.md");
    expect(listing.entries.find((entry) => entry.name === "src")?.path).toBe("src");
  });

  it("filters out tool directories like node_modules", () => {
    const listing = listDirectory(makeRoot(), "");
    expect(listing.entries.map((entry) => entry.name)).not.toContain("node_modules");
  });

  it("lists subdirectories with forward slashes", () => {
    const listing = listDirectory(makeRoot(), "src");
    expect(listing.path).toBe("src");
    expect(listing.entries.map((entry) => entry.path)).toContain("src/main.ts");
  });

  it("`../` 越界被拒", () => {
    expect(() => listDirectory(makeRoot(), "..")).toThrow(/越界/);
  });

  it("rejects absolute paths outside workspace", () => {
    expect(() => listDirectory(makeRoot(), "C:/Windows")).toThrow(/越界/);
  });

  it("reports not a directory when calling list directory on file", () => {
    expect(() => listDirectory(makeRoot(), "README.md")).toThrow(/不是目录/);
  });
});

describe("Read File Preview", () => {
  it("reads text content accurately", () => {
    const preview = readPreview(makeRoot(), "README.md");
    expect(preview.content).toBe("# demo\n");
    expect(preview.binary).toBe(false);
    expect(preview.truncated).toBe(false);
  });

  it("withholds raw content for binary files", () => {
    const preview = readPreview(makeRoot(), "binary.bin");
    expect(preview.binary).toBe(true);
    expect(preview.content).toBe("");
  });

  it("`../` 越界被拒", () => {
    expect(() => readPreview(makeRoot(), "../../etc/passwd")).toThrow(/越界/);
  });

  it("throws error when path is omitted", () => {
    expect(() => readPreview(makeRoot(), "")).toThrow(/未指定有效文件路径/);
  });
});

describe("Git Status", () => {
  it("reports non-git repository accurately instead of claiming zero changes", async () => {
    const summary = await gitSummary(makeRoot());
    expect(summary.isRepo).toBe(false);
    expect(summary.changes).toEqual([]);
    expect(summary.error).toBeNull();
  });
});
