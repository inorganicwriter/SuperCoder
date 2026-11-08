// i18n-exempt-file: 启动断言（缺 #root 是打包错误，不是用户可见文案）
/**
 * 渲染进程入口。遵循架构设计规范 P2。
 *
 * 首帧之前先把主题类名刷到 <html> 上：放在 React 里做会在深色用户启动时闪一下浅色。
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./render/App.js";
import { SessionProvider } from "./render/SessionProvider.js";
import { applyTheme, readTheme } from "./theme/mode.js";
import "./theme/tokens.css";
import "./theme/base.css";

const container = document.getElementById("root");
if (container === null) throw new Error("缺少 #root 容器");

const initialTheme = readTheme(window.localStorage);
applyTheme(document.documentElement, initialTheme);

createRoot(container).render(
  <StrictMode>
    <SessionProvider>
      <App initialTheme={initialTheme} />
    </SessionProvider>
  </StrictMode>,
);
