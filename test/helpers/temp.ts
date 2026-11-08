/**
 * 测试用的临时数据目录。遵循架构设计规范（每个用例独立数据目录）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths, type AppPaths } from "../../src/host/boot/paths.js";

export interface TempHome {
  readonly home: string;
  readonly paths: AppPaths;
  cleanup(): void;
}

export function makeTempHome(prefix = "supercoder-test-"): TempHome {
  const home = mkdtempSync(join(tmpdir(), prefix));
  return {
    home,
    paths: resolveAppPaths({ SUPERCODER_HOME: home }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
