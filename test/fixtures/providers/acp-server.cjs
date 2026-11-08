const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } } });
  else if (msg.method === 'session/new') send({ id: msg.id, result: { sessionId: 'ses_example' } });
  else if (msg.method === 'session/list') send({ id: msg.id, result: { sessions: [{ sessionId: 'ses_example', cwd: process.cwd(), title: 'Test session' }] } });
  else if (msg.method === 'session/load') {
    send({ method: 'session/update', params: { sessionId: 'ses_example', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' } } } });
    send({ id: msg.id, result: {} });
  }
  else if (msg.method === 'session/prompt') {
    global.promptId = msg.id;
    send({ id: 77, method: 'session/request_permission', params: { sessionId: 'ses_example', options: [{ optionId: 'no', kind: 'reject_once', name: 'Reject' }, { optionId: 'yes', kind: 'allow_once', name: 'Allow' }] } });
  } else if (msg.id === 77) {
    const rejected = msg.result?.outcome?.outcome === 'selected' && msg.result.outcome.optionId === 'no';
    const allowed = msg.result?.outcome?.outcome === 'selected' && msg.result.outcome.optionId === 'yes';
    send({ method: 'session/update', params: { sessionId: 'ses_example', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: rejected ? 'permission rejected' : allowed ? 'permission allowed' : 'invalid permission response' } } } });
    send({ id: global.promptId, result: { stopReason: 'end_turn' } });
  }
});
