/**
 * 消息渲染：Markdown + LaTeX 公式。
 *
 * 安全：markdown-it 关闭 html（模型输出里的 HTML 标签按纯文本显示，不会执行），
 * 链接由 markdown-it 自带的 validateLink 过滤（拦掉 javascript: 等）。
 * 公式：自写一个小插件交给 KaTeX，支持 $…$、$$…$$、\(…\)、\[…\]；代码块与行内代码里的 $ 不受影响。
 * KaTeX 出错时（公式写错）原样显示源码，不抛异常。
 */

import katex from "katex";
import MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

function renderMath(source: string, displayMode: boolean): string {
  return katex.renderToString(source, { displayMode, throwOnError: false, output: "html", strict: "ignore" });
}

/** 行内公式：$…$ 与 \(…\)。$ 后紧跟空格或数字前的 $ 不当公式，避免把"$5 和 $10"误判。 */
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  let open: string;
  let close: string;
  if (src.startsWith("\\(", start)) {
    open = "\\(";
    close = "\\)";
  } else if (src[start] === "$" && src[start + 1] !== "$") {
    open = "$";
    close = "$";
    const next = src[start + 1];
    if (next === undefined || next === " " || next === "\t" || next === "\n") return false;
  } else {
    return false;
  }
  let end = start + open.length;
  for (;;) {
    end = src.indexOf(close, end);
    if (end < 0) return false;
    if (src[end - 1] === "\\") {
      end += 1;
      continue;
    }
    break;
  }
  const content = src.slice(start + open.length, end);
  if (content.trim() === "") return false;
  if (open === "$") {
    // 收尾的 $ 前不能是空白，后面不能紧跟数字（"$5 to $10"）。
    if (/\s/.test(content[content.length - 1] ?? "")) return false;
    if (/\d/.test(src[end + 1] ?? "")) return false;
  }
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = content;
  }
  state.pos = end + close.length;
  return true;
}

/** 块级公式：独占的 $$…$$ 或 \[…\]，可以跨行。 */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineStart = (line: number): number => (state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0);
  const lineText = (line: number): string => state.src.slice(lineStart(line), state.eMarks[line] ?? 0);
  const first = lineText(startLine).trim();
  let close: string;
  if (first.startsWith("$$")) close = "$$";
  else if (first.startsWith("\\[")) close = "\\]";
  else return false;
  const openLength = 2;
  let body = first.slice(openLength);
  let line = startLine;
  let found = false;
  if (body.trimEnd().endsWith(close) && body.trim().length >= close.length) {
    body = body.trimEnd().slice(0, -close.length);
    found = true;
  }
  while (!found) {
    line += 1;
    if (line >= endLine) return false;
    const text = lineText(line);
    const at = text.indexOf(close);
    if (at >= 0) {
      body += `\n${text.slice(0, at)}`;
      found = true;
    } else {
      body += `\n${text}`;
    }
  }
  if (silent) return true;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = body.trim();
  token.map = [startLine, line + 1];
  state.line = line + 1;
  return true;
}

function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("escape", "math_inline", mathInline);
  md.block.ruler.after("blockquote", "math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.renderer.rules["math_inline"] = (tokens, index) => renderMath(tokens[index]?.content ?? "", false);
  md.renderer.rules["math_block"] = (tokens, index) => `<div class="sc-math-block">${renderMath(tokens[index]?.content ?? "", true)}</div>\n`;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false }).use(mathPlugin);

// 链接一律新窗口打开，不在应用窗口里跳走。
const defaultLinkOpen = md.renderer.rules["link_open"] ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
md.renderer.rules["link_open"] = (tokens, index, options, env, self) => {
  tokens[index]?.attrSet("target", "_blank");
  tokens[index]?.attrSet("rel", "noreferrer noopener");
  return defaultLinkOpen(tokens, index, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}
