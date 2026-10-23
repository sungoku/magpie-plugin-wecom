import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

async function waitForHealth(base: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('管理服务未在预期时间内启动');
}

test('management API: token auth, secret masking, config merge, static UI', async (t) => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-bridge-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        server: { port, host: '127.0.0.1' },
        defaultAgent: 'claude',
        agents: {
          claude: { type: 'cli', command: 'echo {prompt}', description: 'test agent' },
          sh: { type: 'cli', command: '{prompt}', description: 'shell' },
        },
        bots: [],
      },
      null,
      2
    )
  );

  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [locateCli(), '--config', configPath, '--port', String(port)],
    { cwd: dir, env: { ...process.env, WECOM_BRIDGE_CONFIG: configPath } }
  );
  let logs = '';
  child.stdout.on('data', (d) => { logs += String(d); });
  child.stderr.on('data', (d) => { logs += String(d); });

  t.after(() => {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  try {
    await waitForHealth(base);
  } catch (err) {
    throw new Error(`${(err as Error).message}\n--- server log ---\n${logs}`);
  }

  // --- management UI + token injection -------------------------------
  const indexRes = await fetch(`${base}/`);
  assert.equal(indexRes.status, 200);
  const html = await indexRes.text();
  const match = html.match(/window\.__BRIDGE_TOKEN__=("(?:[^"\\]|\\.)*")/);
  assert.ok(match, '管理页应注入本次会话令牌');
  const token = JSON.parse(match![1]) as string;
  assert.ok(token.length >= 32);

  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  assert.equal((await fetch(`${base}/icon.svg`)).status, 200);
  assert.equal((await fetch(`${base}/_magpie/bridge.js`)).status, 200);

  // --- token is required ---------------------------------------------
  assert.equal((await fetch(`${base}/api/config`)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/config`, { headers: { 'X-Bridge-Token': 'wrong' } })).status,
    401
  );

  const auth = { 'X-Bridge-Token': token, 'Content-Type': 'application/json' };

  const initial = await (await fetch(`${base}/api/config`, { headers: auth })).json();
  assert.deepEqual(initial.bots, []);

  // --- save a bot; the secret must not come back ---------------------
  const secret = 'super-secret-value-for-tests';
  const saveRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      bots: [{
        id: 'b1',
        name: '测试 Bot',
        botId: 'bot-id-1',
        secret,
        defaultAgent: 'claude',
        allowedUsers: ['alice'],
        promptPrefix: '你是测试助手',
      }],
    }),
  });
  assert.equal(saveRes.status, 200);

  const afterSaveText = await (await fetch(`${base}/api/config`, { headers: auth })).text();
  assert.ok(!afterSaveText.includes(secret), 'GET /api/config 不得返回 secret');
  const afterSave = JSON.parse(afterSaveText);
  assert.equal(afterSave.bots[0].secretSet, true);
  assert.ok(afterSave.bots[0].secretMasked.includes('••••'));
  assert.equal(afterSave.bots[0].secret, undefined);

  const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert.equal(onDisk.bots[0].secret, secret);
  assert.equal(onDisk.bots[0].id, 'b1');
  assert.equal(onDisk.bots[0].allowedUsers[0], 'alice');

  // --- sending the masked placeholder keeps the secret ----------------
  const masked = afterSave.bots[0].secretMasked;
  const keepRes = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      bots: [{ id: 'b1', name: '改名', botId: 'bot-id-1', secret: masked, defaultAgent: 'claude' }],
    }),
  });
  assert.equal(keepRes.status, 200);
  const kept = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert.equal(kept.bots[0].secret, secret);
  assert.equal(kept.bots[0].name, '改名');

  // --- content type and notify behavior ------------------------------
  const badType = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'X-Bridge-Token': token, 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(badType.status, 415);

  const notifyBadType = await fetch(`${base}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: '{}',
  });
  assert.equal(notifyBadType.status, 415);

  // No bot is connected, so a real notification is a 503.
  const notify = await fetch(`${base}/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'hello' }),
  });
  assert.equal(notify.status, 503);

  // --- service control ----------------------------------------------
  // Clear the bot id first: connect() then fails locally instead of opening
  // a real WebSocket to WeCom with fake credentials.
  await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      bots: [{ id: 'b1', name: '改名', botId: '', secret, defaultAgent: 'claude' }],
    }),
  });
  const start = await fetch(`${base}/api/service/start`, { method: 'POST', headers: auth });
  assert.equal(start.status, 200);
  const status = await (await fetch(`${base}/api/status`, { headers: auth })).json();
  assert.equal(status.running, true);
  assert.equal(status.bots[0].status, 'error');
  assert.match(status.bots[0].lastError, /缺少 Bot ID/);
  const stop = await fetch(`${base}/api/service/stop`, { method: 'POST', headers: auth });
  assert.equal(stop.status, 200);
});
