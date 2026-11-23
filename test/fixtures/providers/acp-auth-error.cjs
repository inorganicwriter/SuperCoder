// ACP 端点：在 session/prompt 上直接报错，用来区分"没开始干活就失败"和"干到一半失败"。
// 用法：node acp-auth-error.cjs <auth | auth-401 | service-502 | auth-after-output | auth-after-tool>
// auth 用 DSH 缺密钥的原文，service-502 用网关 502 的原文，其余用供应商的 401 原文。
const readline = require('node:readline');
const mode = process.argv[2] ?? 'auth';
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const failure = mode === 'auth'
  ? 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service'
  : mode === 'service-502'
    ? 'Internal error: turn failed: 502 status code (no body)'
    : 'Internal error: turn failed: 401: Authentication Fails, Your api key is invalid';
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1 } });
  else if (msg.method === 'session/new') send({ id: msg.id, result: { sessionId: 'ses_auth' } });
  else if (msg.method === 'session/prompt') {
    if (mode === 'auth-after-output') send({ method: 'session/update', params: { sessionId: 'ses_auth', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } } } });
    if (mode === 'auth-after-tool') send({ method: 'session/update', params: { sessionId: 'ses_auth', update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'read file' } } });
    send({ id: msg.id, error: { code: -32603, message: failure } });
  }
});
