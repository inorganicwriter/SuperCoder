/**
 * 渲染一段 Markdown（含 LaTeX）。HTML 由 renderMarkdown.ts 生成：模型输出里的原始 HTML 已被转义，
 * 所以这里用 dangerouslySetInnerHTML 是安全的——进来的只有 markdown-it 与 KaTeX 自己产出的标签。
 */

import { useMemo } from "react";
import "katex/dist/katex.min.css";
import { renderMarkdown } from "./renderMarkdown.js";
import styles from "./markdown.module.css";

export function Markdown({ text, className }: { readonly text: string; readonly className?: string | undefined }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={className === undefined ? styles.md : `${styles.md} ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
