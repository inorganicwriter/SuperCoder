# SuperCoder

English | [简体中文](README.zh-CN.md)

SuperCoder is a desktop application for orchestrating local coding agents.

It connects to coding agents installed on your machine, dispatches development tasks to the appropriate agent, and provides workspace write locks, session continuation, and one-click Git rollbacks.

> Current version: 0.1 developer preview. Interfaces and storage formats are subject to change.

## Quick Start

### Standalone Installer

Build a standalone installer for machines without a local Node.js or Git environment:

```bash
pnpm install
pnpm dist
# Output generated under: release/
```

### Run from Source

Prerequisites: Node.js >= 22, pnpm.

```bash
git clone https://github.com/inorganicwriter/SuperCoder.git
cd SuperCoder
pnpm install
pnpm build
pnpm start
```

> **Note**: Configure at least one model API key under **Models** in the sidebar before sending your first message.

## Supported Agents

Available agents are detected automatically on launch in priority order:

| Agent | Protocol | Probe Path |
|---|---|---|
| Codex | app-server streaming / CLI | `codex` in PATH, bundled `codex.exe` in desktop app |
| OpenCode | desktop service to ACP | local service port, `opencode-acp.exe`, `opencode` in PATH |
| Antigravity | ACP (`agy acp`) | uninstall registry, `%LOCALAPPDATA%\agy\bin\agy.exe`, `agy` in PATH |
| DeepSeek Harness | built-in ACP | uninstall registry, `%LOCALAPPDATA%\Programs\DeepSeek Harness` |
| Claude Code | CLI pipeline | `claude` in PATH |
| Kimi Code | local desktop service | local service port, install dir in registry (auto-launched if stopped) |

- Task dispatching continues the agent's existing session in the current workspace by default, or you can start a fresh session.
- Mutating tasks acquire an exclusive workspace lock to prevent concurrent file conflicts.

## Data Storage

Data is stored by default under the user data directory (such as `%APPDATA%\SuperCoder` on Windows, customizable via the `SUPERCODER_HOME` environment variable):

```
sessions/<sessionId>/log.jsonl    # full session event log (append-only)
sessions/<sessionId>/index.json   # derived view index cache (safe to delete and rebuild)
sessions/<sessionId>/artifacts/   # task output artifact archives
settings.json                     # application configuration
secrets.bin                       # secure encrypted local credential storage
workspaces.json                   # registered workspace directory paths
```

## Architecture

For details on the append-only event log, multi-agent cascade dispatch, and Git rollback mechanisms, see the [Architecture & System Design](docs/architecture.md).

## Development & Testing

```bash
pnpm check     # typecheck, oxlint, boundary guard, i18n gate
pnpm test      # full test suite (55 suites)
pnpm bench     # performance budget benchmarks
pnpm dist      # build desktop installer
```

## Troubleshooting

**Window fails to launch with `0x80000003`**

The project directory carries a low integrity label, preventing Chromium sandbox initialization. Check and restore permissions using `icacls`:

```powershell
icacls <project-dir> /save acl-backup.txt
icacls <project-dir> /setintegritylevel "(OI)(CI)M"
```

**Installed agent shows not ready**

Refresh status in Settings. If still undetected, check whether the install path contains non-ASCII characters, comes from an npm wrapper script (`.cmd`), or resides on a non-default drive. Diagnostic steps can be found in task card details.

## Acknowledgments

SuperCoder's multi-agent coordination and task pipeline design draw inspiration from:

- [DeepSeek Harness](https://github.com/deepseek-ai)
- [agent-mail](https://github.com/leavelet/agent-mail)

## License

[MIT](LICENSE)
