/**
 * 工作区。遵循架构设计规范。
 *
 * `nativeSessions` 把 provider 自己的会话 id 绑定在工作区上：
 * 任务分派时可恢复，列表里也能看到对方的历史。
 */

import { z } from "zod";

export const WorkspaceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1),
  /** providerId → 原生 sessionId */
  nativeSessions: z.record(z.string(), z.string()).default({}),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** workspaces.json 的整体形状。同样带 `fields` 守卫。 */
export const WorkspacesFileSchema = z.object({
  fields: z.string(),
  activeId: z.string(),
  items: z.array(WorkspaceSchema),
});
export type WorkspacesFile = z.infer<typeof WorkspacesFileSchema>;
