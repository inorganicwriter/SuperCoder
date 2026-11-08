/**
 * 进程异常终止恢复测试的子进程辅助。
 *
 * 只有在**真进程**里才出现的坏状态，造不出来也不该假装造得出来：
 * 缓冲未刷、header 重写一半、tmp 残留、实例锁残留。这个脚本负责「正在写」的那一半，
 * 由测试进程负责 SIGKILL 与事后打开。
 *
 * 用法：node lib-scripts/test/helpers/crash-writer.js <home> [--rename-every <n>]
 *
 * 第一行打印 `SESSION <sessionId>`，之后每写一条打一行 `APPENDED <count> <seq>`。
 *
 * stdout 每写一条打一行 `APPENDED <count> <seq>`，测试按行数判断"已经写到第几条"；
 * `--rename-every <n>` 每 n 条重写一次首行元数据（tmp + rename + 重写索引），
 * 让 SIGKILL 有机会落在"重写一半"的窗口里；
 * `--idle` 只建会话、不写正文，用来覆盖"第一条都还没写"的崩溃点。
 */

import { SessionStore } from "../../src/host/session/store.js";
import { silentLogger } from "../../src/host/boot/logger.js";
import { resolveAppPaths } from "../../src/host/boot/paths.js";

const home = process.argv[2];
const renameArg = process.argv.indexOf("--rename-every");
const renameEvery = renameArg < 0 ? 0 : Number(process.argv[renameArg + 1] ?? "0");

if (home === undefined) {
  process.stderr.write("Missing home directory argument\n");
  process.exit(2);
}

const paths = resolveAppPaths({ SUPERCODER_HOME: home });
const store = new SessionStore({ paths, logger: silentLogger() });
const sessionId = store.create("crash-ws", "崩溃样本").sessionId;
process.stdout.write(`SESSION ${sessionId}\n`);
const handle = store.get(sessionId);

let count = 0;

function appendOne(): void {
  count += 1;
  const step = count % 4;
  if (step === 1) {
    handle.append("user/message", { text: `第 ${String(count)} 条问题`, attachments: [] });
  } else if (step === 2) {
    handle.append("assistant/message", { step: count, text: `第 ${String(count)} 条回答` });
  } else if (step === 3) {
    handle.append("tool/call", {
      callId: `call-${String(count)}`,
      name: "query_task_status",
      args: { task_id: `t-${String(count)}` },
    });
  } else {
    handle.append("tool/result", {
      callId: `call-${String(count)}`,
      outcome: { status: "ok", value: { count } },
    });
  }
  process.stdout.write(`APPENDED ${String(count)} ${String(handle.lastSeq)}\n`);
}

// --idle：仅创建初始会话并等待终止信号，用于测试空日志文件的恢复路径。
if (process.argv.includes("--idle")) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

for (;;) {
  appendOne();
  if (renameEvery > 0 && count % renameEvery === 0) {
    handle.rename(`崩溃样本 ${String(count)}`);
    process.stdout.write(`RENAMED ${String(handle.lastSeq)}\n`);
  }
  // 让出事件循环，也给 SIGKILL 留出落在 write / rename 中间的机会。
  await new Promise((resolve) => setTimeout(resolve, 1));
}
