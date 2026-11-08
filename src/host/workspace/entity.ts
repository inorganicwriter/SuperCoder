/**
 * 工作区实体。遵循架构设计规范。
 *
 * 路径一律 `resolve` 后校验落在工作区根之内；符号链接按真实路径再验一次，
 * 免得 `link -> ..` 把工具带出工作区。
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Workspace } from "../../shared/domain/workspace.js";
import { err, ok, type Result } from "../../shared/result.js";
import type { WorkspacesStore, WorkspacesState } from "../boot/config.js";
import { fail } from "../boot/failure.js";

export class WorkspaceRegistry {
  private state: WorkspacesState;
  /** 读失败的原因。非空即降级为只读：读照常（空列表），写一律显式失败。 */
  private readonly loadError: { message: string; hint: string } | null;

  constructor(private readonly store: WorkspacesStore) {
    const loaded = store.load();
    this.state = loaded.ok ? loaded.value : { activeId: "", items: [] };
    this.loadError = loaded.ok ? null : loaded.error;
  }

  list(): WorkspacesState {
    return this.state;
  }

  active(): Workspace | null {
    return this.state.items.find((item) => item.id === this.state.activeId) ?? null;
  }

  get(id: string): Workspace {
    const found = this.state.items.find((item) => item.id === id);
    if (found === undefined) throw new Error(`找不到工作区 ${id}`);
    return found;
  }

  add(path: string, name?: string): Workspace {
    this.assertWritable();
    const absolute = resolve(path);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
      throw new Error(`目标路径不是目录：${absolute}。`);
    }
    const existing = this.state.items.find(
      (item) => resolve(item.path).toLowerCase() === absolute.toLowerCase(),
    );
    if (existing) return existing;
    const workspace: Workspace = {
      id: randomUUID(),
      path: absolute,
      name: name !== undefined && name.trim() !== "" ? name.trim() : basename(absolute),
      nativeSessions: {},
    };
    this.state = {
      activeId: this.state.activeId === "" ? workspace.id : this.state.activeId,
      items: [...this.state.items, workspace],
    };
    this.persist();
    return workspace;
  }

  remove(id: string): void {
    this.assertWritable();
    this.state = {
      activeId: this.state.activeId === id ? "" : this.state.activeId,
      items: this.state.items.filter((item) => item.id !== id),
    };
    this.persist();
  }

  activate(id: string): void {
    this.assertWritable();
    if (!this.state.items.some((item) => item.id === id)) {
      throw new Error(`未找到工作区 ${id}。`);
    }
    this.state = { ...this.state, activeId: id };
    this.persist();
  }

  /** 记下 provider 自己的会话 id，任务分派时可恢复。 */
  bindNativeSession(workspaceId: string, providerId: string, sessionId: string): void {
    this.assertWritable();
    this.state = {
      ...this.state,
      items: this.state.items.map((item) =>
        item.id === workspaceId
          ? { ...item, nativeSessions: { ...item.nativeSessions, [providerId]: sessionId } }
          : item,
      ),
    };
    this.persist();
  }

  /**
   * 由会话 id 找它的工作区（会话首行里存着 workspace）。
   *
   * 未找到有效根目录时返回空字符串，避免回落到应用自身的安装目录。
   * 工作区被移除后历史会话仍指向它，回落会让工具与回撤在应用目录里动手。
   */
  resolveRoot(workspaceId: string): string {
    const workspace = this.state.items.find((item) => item.id === workspaceId);
    return workspace?.path ?? "";
  }

  /**
   * 读取或解析失败时不执行写入，防止意外覆盖现有配置。
   *
   * 否则"文件坏了 → 内存里当成空列表 → 用户点添加 → 空状态原子写回"
   * 会把还能人工修的路径与 nativeSessions 直接抹掉。
   */
  private assertWritable(): void {
    if (this.loadError === null) return;
    fail(
      "storage_failed",
      `${this.loadError.message}，工作区配置文件读取失败，请检查 ${this.store.file}。`,
    );
  }

  private persist(): void {
    const saved = this.store.save(this.state);
    if (!saved.ok) fail("storage_failed", `${saved.error.message}，请检查数据目录写入权限。`);
  }
}

/**
 * 归一化并校验工具给的路径。
 *
 * 返回绝对路径（保留用户写法），但校验用真实路径：`..`、符号链接都跑不出去。
 */
export function resolveInsideRoot(root: string, candidate: string): Result<string, string> {
  const rootReal = safeRealpath(root);
  const absolute = resolve(rootReal, candidate);
  const relativeToRoot = relative(rootReal, absolute);
  if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) {
    return err(`路径越界：${candidate} 超出工作区 ${root} 范围。`);
  }
  const real = safeRealpath(absolute);
  const realRelative = relative(rootReal, real);
  if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
    return err(
      `符号链接指向工作区之外：${candidate} → ${real}。`,
    );
  }
  return ok(absolute);
}

/** 逐级回退到最近一个存在的祖先，再拼回不存在的尾部。 */
function safeRealpath(target: string): string {
  if (existsSync(target)) {
    try {
      return realpathSync(target);
    } catch {
      return resolve(target);
    }
  }
  const parent = dirname(target);
  if (parent === target) return resolve(target);
  const tail = basename(target);
  return resolve(safeRealpath(parent), tail);
}
