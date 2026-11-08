/**
 * 消息渲染：Markdown + LaTeX。重点是安全与边界——模型输出不可信。
 */

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/client/render/renderMarkdown.js";

describe("Markdown Rendering", () => {
  it("renders standard markdown: headings, lists, code blocks, tables", () => {
    const html = renderMarkdown("## 标题\n\n- 一\n- 二\n\n```ts\nconst a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<h2>标题</h2>");
    expect(html).toContain("<li>一</li>");
    expect(html).toContain('<code class="language-ts">');
    expect(html).toContain("<table>");
  });

  it("escapes raw HTML in model output without execution", () => {
    const html = renderMarkdown('<script>alert(1)</script><img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("blocks javascript: links and opens valid external links in new window", () => {
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain('href="javascript:');
    const html = renderMarkdown("[官网](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
  });

  it("delegates inline and block math formulas to KaTeX", () => {
    expect(renderMarkdown("质能方程 $E=mc^2$ 成立")).toContain('class="katex"');
    expect(renderMarkdown("另一种写法 \\(a^2+b^2\\)")).toContain('class="katex"');
    const block = renderMarkdown("$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$");
    expect(block).toContain("sc-math-block");
    expect(block).toContain("katex-display");
    expect(renderMarkdown("\\[\\sum_{i=1}^n i\\]")).toContain("katex-display");
  });

  it("does not interpret currency dollar signs as math formula", () => {
    const html = renderMarkdown("价格从 $5 涨到 $10");
    expect(html).not.toContain('class="katex"');
    expect(html).toContain("$5");
  });

  it("does not render dollar signs inside code blocks as formulas", () => {
    expect(renderMarkdown("运行 `echo $HOME` 即可")).not.toContain('class="katex"');
    expect(renderMarkdown("```sh\necho $PATH $HOME\n```")).not.toContain('class="katex"');
  });

  it("displays malformed LaTeX formulas safely without throwing exceptions", () => {
    expect(() => renderMarkdown("$\\frac{1$")).not.toThrow();
  });
});
