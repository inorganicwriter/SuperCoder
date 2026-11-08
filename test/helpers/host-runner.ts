/**
 * 一个真的 host 进程（带实例锁），供"杀掉再起"的用例使用。遵循架构设计规范。
 *
 * 用法：node lib-scripts/test/helpers/host-runner.js <home>
 * 起好后往 stdout 打 `READY <port>`，然后一直活着等被 SIGKILL。
 */

import { startHost } from "../../src/host/index.js";
import { silentLogger } from "../../src/host/boot/logger.js";

const home = process.argv[2];
if (home === undefined) {
  process.stderr.write("Missing home directory argument\n");
  process.exit(2);
}

const host = await startHost({ home, port: 0, logger: silentLogger() });
process.stdout.write(`READY ${String(host.port)}\n`);

// 不主动关：这个进程的存在意义就是被 kill -9。
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
