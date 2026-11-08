/**
 * zod → JSON Schema 转换。
 *
 * 模型的工具调用参数走 JSON Schema，而 schema 的唯一源是 zod。
 * 这个脚本把  八个内置工具的参数导成 tools/schemas/<tool>.json，
 * 让模型侧看到的形状与执行侧校验的形状不可能分叉。
 *
 * 运行：pnpm gen:schema
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BUILTIN_TOOL_LIST } from "../src/shared/domain/builtin-tools.js";

export interface ToolSchemaFile {
  readonly name: string;
  readonly description: string;
  readonly mutating: boolean;
  readonly parameters: Record<string, unknown>;
}

export function buildToolSchemas(): ToolSchemaFile[] {
  return BUILTIN_TOOL_LIST.map((tool) => ({
    name: tool.name,
    description: tool.description,
    mutating: tool.mutating,
    parameters: z.toJSONSchema(tool.params, { io: "input" }) as Record<string, unknown>,
  }));
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "..", "..", "tools", "schemas");

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const schemas = buildToolSchemas();
  for (const schema of schemas) {
    const target = join(OUT_DIR, `${schema.name}.json`);
    writeFileSync(target, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`Exported ${schemas.length} tool schemas to ${OUT_DIR}\n`);
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
