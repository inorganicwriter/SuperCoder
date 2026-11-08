/**
 * 配置与工作区清单。遵循架构设计规范。
 *
 * 两者都带 `fields` 守卫：字段变了就把文件当"不认识的版本"，报错并给"重置"入口。
 * 配置与工作区属于易失状态，读取解析失败时重置为默认值。
 */

import { existsSync } from "node:fs";
import { z } from "zod";
import { McpServerInputSchema } from "../../shared/domain/mcp.js";
import { ModelProfileSchema } from "../../shared/domain/model.js";
import { WorkspaceSchema, type Workspace } from "../../shared/domain/workspace.js";
import { readJsonIfPresent, writeJsonAtomic } from "./atomic.js";
import type { AppPaths } from "./paths.js";

export const ApprovalPolicySchema = z.enum(["ask", "auto-read", "never"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const SettingsFileSchema = z.object({
  fields: z.string(),
  language: z.enum(["zh-CN", "en"]),
  defaultModel: z.string().nullable(),
  approvalPolicy: ApprovalPolicySchema,
  /** `run_workspace_verification` 的默认命令（custom_cmd 缺省时用它）。 */
  verificationCommand: z.string(),
  mcpServers: z.array(McpServerInputSchema),
  /** 模型档案；密钥不放这里，只放 secrets.bin 的键名。 */
  models: z.array(ModelProfileSchema).default([]),
});
export type SettingsFile = z.infer<typeof SettingsFileSchema>;
export type Settings = Omit<SettingsFile, "fields">;

export const SETTINGS_FIELDS = Object.keys(SettingsFileSchema.omit({ fields: true }).shape).join(",");

export const DEFAULT_SETTINGS: Settings = {
  language: "zh-CN",
  defaultModel: null,
  approvalPolicy: "ask",
  verificationCommand: "git status --porcelain",
  mcpServers: [],
  models: [],
};

export const WorkspacesFields = Object.keys(
  z.object({ activeId: z.string(), items: z.array(WorkspaceSchema) }).shape,
).join(",");

export interface ConfigError {
  readonly message: string;
  readonly hint: string;
}

export type LoadOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConfigError };

/** settings.json 的读写。守卫失败时给出"重置设置"提示。 */
export class SettingsStore {
  constructor(private readonly paths: AppPaths) {}

  load(): LoadOutcome<Settings> {
    if (!existsSync(this.paths.settingsFile)) {
      return { ok: true, value: DEFAULT_SETTINGS };
    }
    const raw = readJsonIfPresent(this.paths.settingsFile);
    if (raw === null) {
      return {
        ok: false,
        error: {
          message: "settings.json 读不出来（不是合法 JSON）",
          hint: "点“重置设置”回到默认值；原文件会保留为 settings.json.bad。",
        },
      };
    }
    const parsed = SettingsFileSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          message: `settings.json 字段不符：${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
          hint: "点“重置设置”回到默认值；原文件会保留为 settings.json.bad。",
        },
      };
    }
    if (parsed.data.fields !== SETTINGS_FIELDS) {
      return {
        ok: false,
        error: {
          message: `settings.json 的字段清单已过时：应为 ${SETTINGS_FIELDS}，实际 ${parsed.data.fields}`,
          hint: "点“重置设置”回到默认值；原文件会保留为 settings.json.bad。",
        },
      };
    }
    const { fields: _fields, ...rest } = parsed.data;
    return { ok: true, value: rest };
  }

  save(settings: Settings): LoadOutcome<Settings> {
    try {
      writeJsonAtomic(this.paths.settingsFile, { fields: SETTINGS_FIELDS, ...settings });
      return { ok: true, value: settings };
    } catch (error) {
      return {
        ok: false,
        error: { message: `写入 settings.json 失败：${String(error)}`, hint: "检查磁盘空间与权限后重试。" },
      };
    }
  }

  reset(): LoadOutcome<Settings> {
    return this.save(DEFAULT_SETTINGS);
  }
}

export interface WorkspacesState {
  readonly activeId: string;
  readonly items: readonly Workspace[];
}

/** workspaces.json 的读写。 */
export class WorkspacesStore {
  constructor(private readonly paths: AppPaths) {}

  /** 文件路径。读失败时要把"该修哪个文件"写进错误提示。 */
  get file(): string {
    return this.paths.workspacesFile;
  }

  load(): LoadOutcome<WorkspacesState> {
    if (!existsSync(this.paths.workspacesFile)) {
      return { ok: true, value: { activeId: "", items: [] } };
    }
    const raw = readJsonIfPresent(this.paths.workspacesFile);
    if (raw === null) {
      return {
        ok: false,
        error: { message: "workspaces.json 读不出来", hint: "删除该文件后重启，工作区列表会重建为空。" },
      };
    }
    const parsed = z
      .object({ fields: z.string(), activeId: z.string(), items: z.array(WorkspaceSchema) })
      .safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          message: `workspaces.json 字段不符：${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
          hint: "删除该文件后重启，工作区列表会重建为空。",
        },
      };
    }
    if (parsed.data.fields !== WorkspacesFields) {
      return {
        ok: false,
        error: {
          message: `workspaces.json 的字段清单已过时：应为 ${WorkspacesFields}`,
          hint: "删除该文件后重启，工作区列表会重建为空。",
        },
      };
    }
    return { ok: true, value: { activeId: parsed.data.activeId, items: parsed.data.items } };
  }

  save(state: WorkspacesState): LoadOutcome<WorkspacesState> {
    try {
      writeJsonAtomic(this.paths.workspacesFile, {
        fields: WorkspacesFields,
        activeId: state.activeId,
        items: state.items,
      });
      return { ok: true, value: state };
    } catch (error) {
      return {
        ok: false,
        error: { message: `写入 workspaces.json 失败：${String(error)}`, hint: "检查磁盘空间与权限后重试。" },
      };
    }
  }
}
