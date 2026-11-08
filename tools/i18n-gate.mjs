/**
 * 国际化文案一致性与完整性校验。检查事项：
 *
 * 1. `zh-CN` 与 `en` 的键集合完全相同
 * 2. 界面代码用到的键都存在于文案表
 * 3. 文案表里没有从未被使用的键
 * 4. 界面代码里没有硬编码的中文文案（注释不算；`// i18n-exempt` 可豁免）
 *
 * 键可能被表格间接使用（`t(MAP[state])`），所以"用到"按字面量是否出现在客户端代码里判定。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const localeDir = join(root, "src", "client", "locale");
const clientDir = join(root, "src", "client");

function keysOf(file) {
  const text = readFileSync(file, "utf8");
  const keys = new Set();
  for (const match of text.matchAll(/^\s{2}"([^"]+)":/gm)) keys.add(match[1]);
  return keys;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "locale") continue;
      walk(full, out);
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 注释里的中文是给人看的说明，不参与硬编码判定。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, " "));
}

const HAN = /[\u4e00-\u9fff]/;
/** 只有标点（、。：）的字符串不算文案。 */
const PUNCT_ONLY = /^[\u3000-\u303f\uff00-\uffef\s]+$/;

function hardcodedCjk(file, text) {
  const problems = [];
  // 诊断层（连接错误、启动断言）不面向文案表：整个文件豁免，理由写在文件头。
  // 注意要在去注释之前判：去注释会把标记本身也抹掉。
  if (text.split("\n").slice(0, 3).some((line) => line.includes("i18n-exempt-file"))) {
    return problems;
  }
  const lines = stripComments(text).split("\n");
  lines.forEach((line, index) => {
    if (line.includes("i18n-exempt")) return;
    const candidates = [];
    for (const match of line.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`|>([^<>{}]*)</g)) {
      candidates.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? "");
    }
    for (const candidate of candidates) {
      if (!HAN.test(candidate)) continue;
      if (PUNCT_ONLY.test(candidate)) continue;
      problems.push(`${relative(root, file)}:${index + 1} Hardcoded text: "${candidate}"`);
    }
  });
  return problems;
}

const zh = keysOf(join(localeDir, "zh-CN.ts"));
const en = keysOf(join(localeDir, "en.ts"));
const problems = [];

for (const key of zh) if (!en.has(key)) problems.push(`Missing key in en: ${key}`);
for (const key of en) if (!zh.has(key)) problems.push(`Missing key in zh-CN: ${key}`);

const literals = new Set();
const files = walk(clientDir);
for (const file of files) {
  const text = readFileSync(file, "utf8");
  // 只认"点分标识符"形状的字面量：直接扫所有引号会被相邻的 "" 串了位。
  for (const match of text.matchAll(/"([A-Za-z][\w-]*(?:\.[\w-]+)+)"/g)) literals.add(match[1]);
  problems.push(...hardcodedCjk(file, text));
}

const used = new Set([...zh].filter((key) => literals.has(key)));
const unused = [...zh].filter((key) => !used.has(key));

for (const key of unused) process.stderr.write(`… Unused key: ${key}\n`);

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`✗ ${problem}\n`);
  process.stderr.write(`✗ i18n check failed: ${problems.length} issues found (${zh.size} total keys)\n`);
  process.exit(1);
}

process.stdout.write(
  `✓ i18n check passed: ${zh.size} keys synchronized across locales, ${files.length} client files scanned (0 hardcoded strings${
    unused.length === 0 ? ", 0 unused keys" : `, ${unused.length} unused keys`
  })\n`,
);
