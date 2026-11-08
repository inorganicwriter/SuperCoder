/**
 * 数据目录解析。遵循架构设计规范。
 *
 * 可用 `SUPERCODER_HOME` 覆盖；只有这一处决定路径，别处一律从这里取。
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AppPaths {
  readonly home: string;
  readonly workspacesFile: string;
  readonly settingsFile: string;
  readonly secretsFile: string;
  readonly sessionsDir: string;
  /** 旧数据导入时用的旁路目录。 */
  readonly importedSessionsDir: string;
  readonly diagnosticsDir: string;
}

const APP_DIR_NAME = "SuperCoder";

export function resolveAppPaths(env: NodeJS.ProcessEnv = process.env): AppPaths {
  const override = env["SUPERCODER_HOME"];
  const home =
    override && override.trim() !== ""
      ? resolve(override)
      : join(homedir(), "AppData", "Roaming", APP_DIR_NAME);

  return {
    home,
    workspacesFile: join(home, "workspaces.json"),
    settingsFile: join(home, "settings.json"),
    secretsFile: join(home, "secrets.bin"),
    sessionsDir: join(home, "sessions"),
    importedSessionsDir: join(home, "sessions.imported"),
    diagnosticsDir: join(home, "diagnostics"),
  };
}

/** sessionId 会拼进路径，先过白名单，杜绝 `..` 与绝对路径。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isSafeId(value: string): boolean {
  return SAFE_ID.test(value);
}

export function sessionDir(paths: AppPaths, sessionId: string): string {
  if (!isSafeId(sessionId)) throw new Error(`非法会话 id：${sessionId}`);
  return join(paths.sessionsDir, sessionId);
}

export function sessionLogFile(paths: AppPaths, sessionId: string): string {
  return join(sessionDir(paths, sessionId), "log.jsonl");
}

export function sessionIndexFile(paths: AppPaths, sessionId: string): string {
  return join(sessionDir(paths, sessionId), "index.json");
}
