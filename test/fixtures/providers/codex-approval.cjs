const readline = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'test') {
    global.requestId = message.id;
    send({ id: 77, method: 'item/commandExecution/requestApproval', params: {} });
  } else if (message.id === 77) send({ id: global.requestId, result: message.result });
});
