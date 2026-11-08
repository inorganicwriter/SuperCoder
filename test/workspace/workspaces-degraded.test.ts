/**
 * workspaces.json 坏了怎么办。遵循架构设计规范。
 *
 * 读失败原本被静默吞掉（`loaded.ok ? loaded.value : { activeId: "", items: [] }`），
 * 于是"列表是空的"和"文件读不出来"在界面上完全一样：用户下次点"添加工作区"，
 * 空状态就被原子写回磁盘，坏文件里能人工修的内容（路径、nativeSessions）全没了。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startHost } from "../../src/host/index.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { createTestBackend } from "../../src/host/boot/secrets.js";
import { WorkspacesStore } from "../../src/host/boot/config.js";
import { WorkspaceRegistry } from "../../src/host/workspace/entity.js";
import type { ErrorCode } from "../../src/shared/protocol/errors.js";
import { makeTempHome } from "../helpers/temp.js";

const logger = silentLogger();
const CORRUPT = '{"fields": "workspace/v1", "activeId": "", "items": [ 这不是 JSON';

describe("Workspace Degraded State Handling", () => {
  it("keeps workspace list readable while blocking writes without altering corrupt file", async () => {
    const temp = makeTempHome();
    writeFileSync(temp.paths.workspacesFile, CORRUPT, "utf8");

    const host = await startHost({
      home: temp.home,
      port: 0,
      logger,
      skipInstanceLock: true,
      secretBackend: createTestBackend(),
      rendererDir: null,
    });
    try {
      // 读：能用，只是空列表。
      const list = await host.rpc("workspace.list", {});
      expect(list.ok).toBe(true);
      if (list.ok) expect(list.result).toEqual({ activeId: "", items: [] });

      // 写：必须显式失败，并指出该修哪个文件。
      const added = await host.rpc("workspace.add", { path: temp.home, name: "临时" });
      expect(added.ok).toBe(false);
      if (!added.ok) {
        const error = added.error as { code: ErrorCode; message: string };
        expect(error.code).toBe("storage_failed");
        expect(error.message).toContain("workspaces.json");
        expect(error.message).toContain("工作区");
        expect(error.message).toContain(temp.paths.workspacesFile);
      }

      const removed = await host.rpc("workspace.remove", { id: "whatever" });
      expect(removed.ok).toBe(false);
      if (!removed.ok) expect(removed.error.code).toBe("storage_failed");

      // 坏文件一个字节都没变：没有"重置后写回"。
      expect(readFileSync(temp.paths.workspacesFile, "utf8")).toBe(CORRUPT);
    } finally {
      await host.close();
      temp.cleanup();
    }
  });

  it("enforces read-only safety guard directly in registry independent of RPC", () => {
    const temp = makeTempHome();
    writeFileSync(temp.paths.workspacesFile, CORRUPT, "utf8");
    try {
      const registry = new WorkspaceRegistry(new WorkspacesStore(temp.paths));
      // 降级：只读查询返回空，不抛。
      expect(registry.list().items).toEqual([]);
      expect(registry.active()).toBeNull();
      let caught: unknown = null;
      try {
        registry.add(temp.home, "临时");
      } catch (error) {
        caught = error;
      }
      expect(caught).not.toBeNull();
      expect(String(caught)).toContain("工作区");
      expect(readFileSync(temp.paths.workspacesFile, "utf8")).toBe(CORRUPT);
      expect(existsSync(temp.paths.workspacesFile)).toBe(true);
    } finally {
      temp.cleanup();
    }
  });
});
