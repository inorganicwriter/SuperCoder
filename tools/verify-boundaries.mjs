/**
 * 验证架构分层定义的模块依赖边界规则有效性。
 *
 * 流程：先验证基线依赖合规，再注入测试用例验证违规导入拦截是否准确触发，
 * 每次注入后立刻删除。任何一步不符预期即非零退出。
 *
 * 运行：pnpm verify:boundaries
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = ".dependency-cruiser.cjs";

/** 从依赖包自带的 bin 字段取入口，避开 Windows 上的 .cmd 包装。 */
function depcruiseBin() {
  const pkgFile = join(ROOT, "node_modules", "dependency-cruiser", "package.json");
  if (!existsSync(pkgFile)) {
    throw new Error("dependency-cruiser is not installed, run pnpm install first");
  }
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.depcruise;
  if (!rel) throw new Error("Cannot find bin entry for dependency-cruiser");
  return join(ROOT, "node_modules", "dependency-cruiser", rel);
}

function runDepcruise(bin) {
  try {
    const stdout = execFileSync(process.execPath, [bin, "src", "--config", CONFIG, "--output-type", "err"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { failed: false, output: stdout };
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : "";
    const stderr = typeof error.stderr === "string" ? error.stderr : "";
    return { failed: true, output: `${stdout}\n${stderr}` };
  }
}

const CASES = [
  {
    name: "shared imports node core",
    file: "src/shared/__violation_core.ts",
    source: 'import { readFileSync } from "node:fs";\nexport const probe = readFileSync;\n',
    expectRule: "shared-no-core",
  },
  {
    name: "shared imports react",
    file: "src/shared/__violation_react.ts",
    source: 'import { useState } from "react";\nexport const probe = useState;\n',
    expectRule: "shared-no-platform-packages",
  },
  {
    name: "client/object imports react",
    file: "src/client/object/__violation_react.ts",
    source: 'import { useState } from "react";\nexport const probe = useState;\n',
    expectRule: "client-object-no-react",
  },
];

const bin = depcruiseBin();
let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`× ${message}`);
}

function cruisedModules(output) {
  const matched = output.match(/\((\d+) modules?/);
  return matched ? Number(matched[1]) : 0;
}

const clean = runDepcruise(bin);
if (clean.failed) {
  fail("Architecture baseline dependency check failed");
  console.error(clean.output.trim());
} else if (cruisedModules(clean.output) === 0) {
  // 解析器异常时 depcruise 可能返回 0 模块并误报成功，需要显式防范。
  fail("0 modules cruised: parser did not run, check environment compatibility");
} else {
  console.log(`✓ Architecture baseline check passed (${cruisedModules(clean.output)} modules cruised)`);
}

for (const testCase of CASES) {
  const abs = join(ROOT, testCase.file);
  try {
    writeFileSync(abs, testCase.source, "utf8");
    const result = runDepcruise(bin);
    const hitRule = result.output.includes(testCase.expectRule);
    if (!result.failed) {
      fail(`Rule check failed: "${testCase.name}" was not caught by rule ${testCase.expectRule}`);
    } else if (!hitRule) {
      fail(`Rule check failed: "${testCase.name}" did not match expected rule ${testCase.expectRule}`);
      console.error(result.output.trim());
    } else {
      console.log(`✓ Boundary rule enforced: ${testCase.name} (${testCase.expectRule})`);
    }
  } finally {
    rmSync(abs, { force: true });
  }
}

const restored = runDepcruise(bin);
if (restored.failed) {
  fail("Dependency check failed after cleaning up test files");
  console.error(restored.output.trim());
} else if (cruisedModules(restored.output) === 0) {
  fail("0 modules cruised after cleanup");
} else {
  console.log("✓ Temporary test files removed and workspace state restored");
}

if (failures > 0) {
  console.error(`\nBoundary verification failed: ${failures} issues found`);
  process.exit(1);
}
console.log(`\nBoundary verification passed: all ${CASES.length} rules enforced`);
