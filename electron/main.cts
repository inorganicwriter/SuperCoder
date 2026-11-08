/**
 * Electron 主进程与生命周期管理。
 *
 * 顺序：数据目录 → 起 host（同进程）→ 开窗口指向 host 的端口。
 * host 与窗口同源，所以  的握手校验不需要为开发环境开口子。
 * 单实例由 host 的 instance.lock 把关：第二份会在这个文件上落败并弹出说明。
 * 每一步都先写启动日志，窗口没出来时凭日志定位。
 */

import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  shell,
} from "electron";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface HostHandle {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  close(): Promise<void>;
}

interface SecretBackend {
  readonly available: boolean;
  readonly reason?: string;
  encrypt(plaintext: string): string;
  decrypt(payload: string): string;
}

const APP_NAME = "SuperCoder";

let host: HostHandle | null = null;
let window: BrowserWindow | null = null;
let quitting = false;

function appHome(): string {
  const override = process.env["SUPERCODER_HOME"];
  if (override !== undefined && override.trim() !== "") return override;
  return join(app.getPath("appData"), APP_NAME);
}

function logFile(): string {
  return join(appHome(), "logs", "main.log");
}

/** 启动日志。窗口没出来时，这是唯一能说明走到哪一步的东西。 */
function startupLog(step: string): void {
  try {
    mkdirSync(join(appHome(), "logs"), { recursive: true });
    appendFileSync(logFile(), `${new Date().toISOString()} ${step}\n`);
  } catch {
    // 日志本身写不进去时继续启动，界面里的错误提示仍然有效。
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * 系统加密不可用时只有一个选择：明确拒绝保存。
 * 系统加密不可用时拒绝写入，避免将密钥以明文形式保存。
 */
function secretBackend(): SecretBackend {
  if (!safeStorage.isEncryptionAvailable()) {
    return {
      available: false,
      reason: "系统加密不可用（Windows 上常见于远程会话或受限账户）",
      encrypt: () => {
        throw new Error("系统加密不可用");
      },
      decrypt: () => {
        throw new Error("系统加密不可用");
      },
    };
  }
  return {
    available: true,
    encrypt: (plaintext) => safeStorage.encryptString(plaintext).toString("base64"),
    decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, "base64")),
  };
}

async function startHost(home: string): Promise<HostHandle> {
  const modulePath = join(__dirname, "..", "lib", "host", "index.js");
  if (!existsSync(modulePath)) {
    throw new Error(`找不到 host 产物：${modulePath}｜下一步：先执行 pnpm build。`);
  }
  const loaded = (await import(pathToFileURL(modulePath).href)) as {
    startHost: (options: {
      home: string;
      rendererDir: string | null;
      secretBackend: SecretBackend;
    }) => Promise<HostHandle>;
  };
  return await loaded.startHost({
    home,
    // 界面是 React 客户端，由 `pnpm build:renderer` 产出到 dist/renderer。
    rendererDir: join(app.getAppPath(), "dist", "renderer"),
    secretBackend: secretBackend(),
  });
}

/**
 * 把端口 / token / 数据目录 / 版本交给 preload。
 *
 * 走 `ipcRenderer.sendSync` 而不是命令行参数：进程的命令行对同机其它进程可见
 * （任务管理器、wmic、ps 都能读），token 等于明文广播。preload 需要同步拿到这些值
 * 才能继续用 `contextBridge` 一次性暴露给渲染进程，所以这里用同步 IPC 应答。
 */
function registerBootstrapChannel(handle: HostHandle): void {
  ipcMain.on("sc:bootstrap", (event) => {
    event.returnValue = {
      port: handle.port,
      token: handle.token,
      home: appHome(),
      version: app.getVersion(),
    };
  });

  // 界面切明暗时同步原生外观：只改页面会让菜单、对话框、标题栏与正文打架。
  ipcMain.on("sc:theme", (_event, mode: unknown) => {
    nativeTheme.themeSource = mode === "dark" ? "dark" : "light";
  });

  /**
   * 选目录。界面上「添加工作区」不该让人手打路径 —— 原生对话框拿到的路径还带盘符大小写
   * 与 UNC 前缀的真实写法，比手打可靠。取消返回 null，渲染进程据此什么都不做。
   */
  /**
 * 把链接交给系统浏览器。Google 登录必须走系统浏览器（嵌入式 webview 会被
 * Google 判成 disallowed_useragent），所以需要一个 IPC 桥。
 * 只放行 http/https，别的 scheme 一律拒绝。
 */
ipcMain.handle("sc:open-external", async (_event, raw: unknown): Promise<boolean> => {
  const url = typeof raw === "string" ? raw : "";
  if (!url.startsWith("https://") && !url.startsWith("http://")) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle("sc:pick-directory", async (): Promise<string | null> => {
    if (window === null) return null;
    const result = await dialog.showOpenDialog(window, {
      title: "选择工作区目录",
      buttonLabel: "选择此文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });
}

function createWindow(handle: HostHandle): void {
  window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    // 与 tokens.css 的 --sc-bg 一致：窗口在页面画出来之前先铺这个色，避免闪一下白/黑底。
    backgroundColor: "#faf9f5",
    title: APP_NAME,
    ...windowIcon(),
    show: false,
    // 不要原生菜单条：Windows 上它是一条白边 + 几个菜单按钮，和界面自己的左栏重复。
    // 快捷键仍然有效（buildMenu 里注册的 F5 / Ctrl+Q 等由菜单承载，只是不显示）。
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window?.show());
  // autoHideMenuBar 只是"按 Alt 才出现"；这里再显式隐藏一次，保证首帧就没有那条白边。
  window.setMenuBarVisibility(false);
  window.on("closed", () => {
    window = null;
  });

  // 只允许留在本机页面里：外部链接交给系统浏览器。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(handle.url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // token 只走 IPC（见 registerBootstrapChannel）：URL 里不留凭据，
  // 否则页面地址会带着它进历史记录、日志与崩溃转储。
  void window.loadURL(handle.url);
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        {
          label: "打开数据目录",
          click: () => {
            void shell.openPath(appHome());
          },
        },
        {
          label: "重新加载界面",
          accelerator: "F5",
          click: () => window?.reload(),
        },
        { type: "separator" },
        {
          label: "退出",
          accelerator: "CmdOrCtrl+Q",
          click: () => app.quit(),
        },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "toggleDevTools" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * 窗口图标。打包版的 exe 里已经嵌了 build/icon.ico，Windows 会直接用它；
 * 开发模式跑的是 node_modules 里的原版 electron.exe，不显式给图标就是 Electron 的默认图标。
 */
function windowIcon(): { icon?: string } {
  const icon = join(app.getAppPath(), "build", "icon.ico");
  return existsSync(icon) ? { icon } : {};
}

async function bootstrap(): Promise<void> {
  startupLog(`启动｜Electron ${process.versions["electron"] ?? "?"}｜打包版 ${app.isPackaged}`);
  const home = appHome();
  process.env["SUPERCODER_HOME"] = home;
  app.setPath("userData", home);
  app.setName(APP_NAME);
  // 与 electron-builder.yml 的 appId 一致：任务栏按它分组和取图标，开发版不再挂在"Electron"名下。
  app.setAppUserModelId("com.supercoder.desktop");
  // 界面默认浅色（见 src/client/theme/tokens.css）；用户切到深色时由 sc:theme 改回来。
  nativeTheme.themeSource = "light";
  startupLog(`数据目录｜${home}`);
  buildMenu();
  startupLog("菜单就绪");
  try {
    host = await startHost(home);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    startupLog(`host 启动失败｜${describe(error)}`);
    dialog.showErrorBox(
      "启动失败",
      `${message}\n\n数据目录：${home}\n日志：${logFile()}`,
    );
    app.quit();
    return;
  }
  startupLog(`host 就绪｜端口 ${host.port}`);
  // 必须在开窗口之前注册：preload 会在页面加载时同步等这个应答。
  registerBootstrapChannel(host);
  createWindow(host);
  startupLog("窗口就绪");
  if (app.isPackaged) {
    void import("electron-updater")
      .then((module) => module.autoUpdater.checkForUpdatesAndNotify())
      .catch(() => undefined);
  }
}

app.on("before-quit", (event) => {
  if (host === null) return;
  if (!quitting) {
    quitting = true;
    event.preventDefault();
    const handle = host;
    host = null;
    void handle.close().finally(() => app.quit());
  }
});

app.on("window-all-closed", () => {
  // 没有托盘：关掉窗口就退出。之前留着托盘、关窗口不退出，
  // 结果任务栏没有图标、进程还在，看起来像"关不掉"。
  app.quit();
});

process.on("uncaughtException", (error) => {
  startupLog(`未捕获异常｜${describe(error)}`);
});

startupLog(`主进程已加载｜Electron ${process.versions["electron"] ?? "?"}`);

void app
  .whenReady()
  .then(bootstrap)
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    startupLog(`启动失败｜${describe(error)}`);
    dialog.showErrorBox("启动失败", `${message}\n\n日志：${logFile()}`);
    app.exit(1);
  });
