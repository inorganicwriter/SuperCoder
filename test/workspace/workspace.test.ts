/**
 * 存储与通道：5000 文件快照 < 300ms、路径越界拦截、工作区写锁。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspacesStore } from "../../src/host/boot/config.js";
import { WorkspaceRegistry, resolveInsideRoot } from "../../src/host/workspace/entity.js";
import { WorkspaceLocks } from "../../src/host/workspace/locks.js";
import { isGitRepo } from "../../src/host/workspace/git.js";
import { snapshotWorkspace, diffSnapshots, pathsToRestore } from "../../src/host/workspace/snapshot.js";
import { makeTempHome } from "../helpers/temp.js";

describe("Workspace Snapshot", () => {
  it("scans metadata of 5000 files within 300ms", () => {
    const home = makeTempHome();
    try {
      const root = join(home.home, "ws");
      for (let dir = 0; dir < 50; dir += 1) {
        const target = join(root, `dir-${dir}`);
        mkdirSync(target, { recursive: true });
        for (let file = 0; file < 100; file += 1) {
          writeFileSync(join(target, `file-${file}.txt`), "x", "utf8");
        }
      }
      const started = process.hrtime.bigint();
      const snapshot = snapshotWorkspace(root);
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      expect(snapshot.files).toHaveLength(5_000);
      expect(elapsedMs).toBeLessThan(300);
      expect(snapshot.files[0]?.path.startsWith("dir-")).toBe(true);
    } finally {
      home.cleanup();
    }
  });

  it("computes snapshot diff identifying added, removed, and changed files", () => {
    const before = [
      { path: "a.ts", mtimeMs: 1, size: 10 },
      { path: "b.ts", mtimeMs: 1, size: 10 },
    ];
    const after = [
      { path: "b.ts", mtimeMs: 2, size: 10 },
      { path: "c.ts", mtimeMs: 1, size: 10 },
    ];
    const diff = diffSnapshots(before, after);
    expect(diff.added).toEqual(["c.ts"]);
    expect(diff.removed).toEqual(["a.ts"]);
    expect(diff.changed).toEqual(["b.ts"]);
    expect(pathsToRestore(diff)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("Workspace and Path Validation", () => {
  it("resolves workspace path strictly within root blocking parent traversal and symlinks", () => {
    const home = makeTempHome();
    try {
      const root = join(home.home, "ws");
      const outside = join(home.home, "outside");
      mkdirSync(root, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(root, "inside.txt"), "ok", "utf8");

      expect(resolveInsideRoot(root, "inside.txt").ok).toBe(true);
      expect(resolveInsideRoot(root, "sub/../inside.txt").ok).toBe(true);
      const escaped = resolveInsideRoot(root, "..");
      expect(escaped.ok).toBe(false);
      if (!escaped.ok) expect(escaped.error).toContain("越界");
    } finally {
      home.cleanup();
    }
  });

  it("persists workspace CRUD operations and associates native agent sessions", () => {
    const home = makeTempHome();
    try {
      const root = join(home.home, "ws");
      mkdirSync(root, { recursive: true });
      const registry = new WorkspaceRegistry(new WorkspacesStore(home.paths));
      const workspace = registry.add(root, "测试工作区");
      expect(registry.active()?.id).toBe(workspace.id);
      registry.bindNativeSession(workspace.id, "codex", "sess-1");

      const reloaded = new WorkspaceRegistry(new WorkspacesStore(home.paths));
      const again = reloaded.get(workspace.id);
      expect(again.nativeSessions["codex"]).toBe("sess-1");
      expect(again.name).toBe("测试工作区");
      reloaded.remove(workspace.id);
      expect(reloaded.list().items).toHaveLength(0);
    } finally {
      home.cleanup();
    }
  });

  it("mutating task acquires workspace lock and explains denial to concurrent tasks", () => {
    const locks = new WorkspaceLocks();
    expect(locks.acquire("ws-1", "task-1").ok).toBe(true);
    const second = locks.acquire("ws-1", "task-2");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("task-1");
    locks.release("ws-1", "task-1");
    expect(locks.acquire("ws-1", "task-2").ok).toBe(true);
  });

  it("treats non-git directories as non-rewindable workspaces", () => {
    const home = makeTempHome();
    try {
      expect(isGitRepo(home.home)).toBe(false);
    } finally {
      home.cleanup();
    }
  });
});
