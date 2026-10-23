import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';

function locateCli(): string {
  const candidates = [
    path.resolve(process.cwd(), 'dist/cli.js'),
    path.resolve(process.cwd(), 'packages/core/dist/cli.js'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  throw new Error('dist/cli.js 不存在，请先运行 npm run build');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

test('MCP stdio server answers initialize, tools, ping and errors', async (t) => {
  const port = await freePort();
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [locateCli(), 'mcp', '--port', String(port)],
    { cwd: process.cwd() }
  );

  t.after(() => {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  });

  const responses = new Map<number, any>();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (typeof msg.id === 'number') responses.set(msg.id, msg);
    } catch {
      // ignore logs accidentally written to stdout
    }
  });

  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const waitFor = async (id: number, timeoutMs = 5000): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (responses.has(id)) return responses.get(id);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`MCP 未在预期时间内响应 id=${id}`);
  };

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const init = await waitFor(1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'wecom-agent-bridge-mcp');

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const list = await waitFor(2);
  assert.equal(list.result.tools[0].name, 'wecom_send_notification');

  send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  assert.deepEqual((await waitFor(3)).result, {});

  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal((await waitFor(4)).error.code, -32601);

  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'wecom_send_notification', arguments: { content: '' } },
  });
  assert.equal((await waitFor(5)).result.isError, true);

  // No gateway listens on the freshly released port: the tool must report
  // failure instead of hanging or throwing.
  send({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'wecom_send_notification', arguments: { content: 'hello' } },
  });
  const failed = await waitFor(6);
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /推送失败/);
});
