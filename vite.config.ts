/**
 * 渲染进程构建配置。
 *
 * 产物在 `dist/renderer`，由 host 的 HTTP 服务在同一个端口上发出去，
 * 因此页面的 Origin 与 Host 天然同源， 的握手校验不需要为开发模式开口子。
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "src/client");

/** node_modules 里的包路径前缀（Windows 上是反斜杠，两边都要认）。 */
const modules = /[\\/]node_modules[\\/]/;

export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist/renderer"),
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome120",
    rolldownOptions: {
      input: resolve(root, "index.html"),
      output: {
        // 依赖按包分组，各自成 chunk：改动应用代码时，这些大依赖的哈希不变，浏览器缓存仍然有效。
        // 分组之后每个 chunk 都小于 500 kB，构建不再触发体积告警。
        codeSplitting: {
          groups: [
            { name: "react", test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: "katex", test: /[\\/]node_modules[\\/]katex[\\/]/ },
            {
              name: "markdown",
              test: /[\\/]node_modules[\\/](markdown-it|linkify-it|mdurl|uc\.micro|punycode|entities)[\\/]/,
            },
            { name: "vendor", test: modules },
          ],
        },
      },
    },
  },
  server: {
    // 开发时也用同一个端口策略：由 host 服务静态文件，不开第二个服务。
    host: "127.0.0.1",
    port: 5199,
    strictPort: true,
  },
});
