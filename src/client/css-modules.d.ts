/**
 * 样式与静态资源声明。Vite 处理实际打包，TypeScript 只需要知道它们能 import。
 */

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}

declare module "*.css";
