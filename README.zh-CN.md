# SuperCoder

[English](README.md) | 简体中文

SuperCoder 是一个本地编程 Agent 调度桌面客户端。

支持连接本机已安装的各类编程 Agent，将开发任务分派给合适的 Agent 执行，并提供工作区文件写锁、会话持久化与 Git 改动一键回撤。

> 当前处于 0.1 版本，接口与存储格式仍在迭代中。

## 快速上手

### 独立安装包

运行以下命令构建无需本地 Node.js / Git 环境的安装包：

```bash
pnpm install
pnpm dist
# 生成产物位于 release/
```

### 源码运行

环境要求：Node.js >= 22、pnpm。

```bash
git clone https://github.com/inorganicwriter/SuperCoder.git
cd SuperCoder
pnpm install
pnpm build
pnpm start
```

> **提示**：首次使用前，请在侧边栏「模型管理」中配置至少一个大模型 API Key（用于内置会话与任务规划）。

## 支持的 Agent

系统启动时会自动探测本机安装的 Agent（按优先级匹配）：

| Agent | 接入协议 | 探测路径 |
|---|---|---|
| Codex | app-server 流式协议 / CLI | 环境变量 PATH 中的 `codex`，桌面版内置的 `codex.exe` |
| OpenCode | 桌面服务转 ACP 协议 | 本地服务端口，`opencode-acp.exe`，PATH 中的 `opencode` |
| Antigravity | ACP 协议 | 注册表卸载项，`%LOCALAPPDATA%\agy\bin\agy.exe`，PATH 中的 `agy` |
| DeepSeek Harness | 内置 ACP 协议 | 注册表卸载项，`%LOCALAPPDATA%\Programs\DeepSeek Harness` |
| Claude Code | CLI 管道 | PATH 中的 `claude` |
| Kimi Code | 本地桌面服务 | 本地监听服务，注册表安装目录（未启动时会自动拉起） |

- 分派任务时默认复用该 Agent 在当前工作区的既有会话上下文，也可以选择新建会话。
- 写入任务受工作区排他锁保护，防止多个 Agent 同时修改同一份代码。

## 数据存储

数据默认存储在用户数据目录（Windows 下为 `%APPDATA%\SuperCoder`，可通过 `SUPERCODER_HOME` 环境变量自定义）：

```
sessions/<sessionId>/log.jsonl    # 会话事件全量日志（追加写入）
sessions/<sessionId>/index.json   # 视图派生索引缓存（可安全删除与重建）
sessions/<sessionId>/artifacts/   # 任务输出产物归档
settings.json                     # 应用基础配置
secrets.bin                       # 本地安全加密的凭据存储
workspaces.json                   # 已关联的工作区路径列表
```

## 技术架构

关于事件日志存储机制、多 Agent 级联调度与 Git 回撤的详细实现，见 [系统架构文档（英文）](docs/architecture.md)。

## 开发与测试

```bash
pnpm check     # 类型检查、oxlint、架构依赖边界与 i18n 校验
pnpm test      # 全量单元测试（55 套测试套件）
pnpm bench     # 性能基准测试
pnpm dist      # 打包桌面安装包
```

## 常见问题

**启动报错 `0x80000003` 打不开窗口**

项目目录带了低完整性标签导致 Chromium 沙箱启动失败。可通过检查并恢复权限：

```powershell
icacls <项目目录> /save acl-backup.txt
icacls <项目目录> /setintegritylevel "(OI)(CI)M"
```

**已安装的 Agent 显示未就绪**

在设置中刷新状态。若仍未识别，检查安装路径是否包含非 ASCII 字符、是否来自 npm 包装脚本（`.cmd`）、或安装在非默认盘符。如仍异常，可查看任务卡片中的具体探测日志。

## 致谢

SuperCoder 的多 Agent 协同与任务管道设计参考了以下开源项目：

- [DeepSeek Harness](https://github.com/deepseek-ai)
- [agent-mail](https://github.com/leavelet/agent-mail)

## License

[MIT](LICENSE)
