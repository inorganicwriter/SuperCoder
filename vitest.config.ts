import { defineConfig } from "vitest/config";

/**
 * 测试配置。
 *
 * `src/**` 用 NodeNext 的 `.js` 后缀写法，vitest 走 Vite 解析，天然认得。
 * 每个用例都用自己的临时目录，互不污染；默认不并行跑同一数据目录。
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    fileParallelism: false,
    reporters: ["default"],
  },
});
