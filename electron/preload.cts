/**
 * 预加载脚本与安全桥接。
 *
 * 只暴露四样东西：端口、token、数据目录、版本。
 * 渲染进程拿不到 Node，也拿不到 IPC 通道以外的主进程能力。
 *
 * 这些值走同步 IPC 取，**不走命令行参数**：进程的命令行对同机其它进程可见，
 * token 放进去等于明文广播（P2-8）。同步是因为 `contextBridge` 必须在 preload
 * 顶层一次性暴露完，渲染进程不该为拿一个端口等待异步回调。
 */

import { contextBridge, ipcRenderer } from "electron";

interface Bootstrap {
  port: number;
  token: string;
  home: string;
  version: string;
}

function bootstrap(): Bootstrap | null {
  try {
    const value = ipcRenderer.sendSync("sc:bootstrap") as unknown;
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<Bootstrap>;
    if (typeof candidate.port !== "number" || typeof candidate.token !== "string") return null;
    return {
      port: candidate.port,
      token: candidate.token,
      home: typeof candidate.home === "string" ? candidate.home : "",
      version: typeof candidate.version === "string" ? candidate.version : "",
    };
  } catch {
    return null;
  }
}

const handle = bootstrap();

if (handle === null) {
  // 缺参数说明启动路径不对：不要提供一个"看起来能连"的假对象。
  console.error("preload：拿不到启动参数（sc:bootstrap）");
} else {
  contextBridge.exposeInMainWorld("supercoder", {
    ...handle,
    /**
     * 界面切明暗时顺带通知主进程，让原生菜单/对话框跟着换 —— 只改页面会让一半深一半浅。
     * 只接受两个字面量，别的一律当浅色。
     */
    setTheme: (mode: string): void => {
      ipcRenderer.send("sc:theme", mode === "dark" ? "dark" : "light");
    },
    /**
     * 打开系统"选择文件夹"对话框，返回绝对路径；用户取消时返回 null。
     * 走 ipcMain.handle，主进程用 dialog.showOpenDialog 拿真实路径。
     */
    pickDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke("sc:pick-directory") as Promise<string | null>,
    /**
     * 用系统浏览器打开一个链接，目前给 Google 登录用。
     * 主进程只放行 http/https，别的协议返回 false。
     */
    openExternal: (url: string): Promise<boolean> =>
      ipcRenderer.invoke("sc:open-external", url) as Promise<boolean>,
  });
}
