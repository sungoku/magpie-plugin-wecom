import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const service = await import(pathToFileURL(path.resolve(here, '../service.js')).href);
const {
  ensureService,
  findGateway,
  isServiceHealthy,
  serviceLogPath,
  serviceTarget,
} = service;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test('serviceTarget only accepts a plain-HTTP loopback notify URL', () => {
  const target = serviceTarget('http://127.0.0.1:9123/notify');
  assert.equal(target.port, 9123);
  assert.equal(target.host, '127.0.0.1');
  assert.equal(target.origin, 'http://127.0.0.1:9123');
  assert.equal(target.healthUrl, 'http://127.0.0.1:9123/health');

  // localhost may resolve to ::1 first, while the gateway binds 127.0.0.1.
  assert.equal(
    serviceTarget('http://localhost:9123/notify').healthUrl,
    'http://127.0.0.1:9123/health'
  );
  assert.equal(serviceTarget(undefined).port, 9099);

  // A remote host, a proxy, IPv6 loopback, or garbage is not ours to start.
  assert.equal(serviceTarget('http://10.0.0.2:9123/notify'), null);
  assert.equal(serviceTarget('https://127.0.0.1:9123/notify'), null);
  assert.equal(serviceTarget('http://[::1]:9123/notify'), null);
  assert.equal(serviceTarget('not a url'), null);
  assert.equal(serviceTarget('ftp://127.0.0.1:9123/notify'), null);
});

test('isServiceHealthy requires our /health payload', async (t) => {
  let status = 200;
  let payload = { status: 'ok', service: 'wecom-agent-bridge' };
  const server = http.createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/notify`;
  assert.equal(await isServiceHealthy(url), true);

  payload = { status: 'ok', service: 'something-else' };
  assert.equal(await isServiceHealthy(url), false);

  payload = { status: 'ok', service: 'wecom-agent-bridge' };
  status = 500;
  assert.equal(await isServiceHealthy(url), false);

  status = 200;
  payload = { status: 'degraded', service: 'wecom-agent-bridge' };
  assert.equal(await isServiceHealthy(url), false);

  const closed = await unusedPort();
  assert.equal(
    await isServiceHealthy(`http://127.0.0.1:${closed}/notify`, { timeoutMs: 200 }),
    false
  );
  assert.equal(await isServiceHealthy('http://example.com/notify'), false);
});

test('findGateway finds a built checkout, never an unrelated folder', () => {
  const root = tempDir('wecom-gateway-');
  const plugin = path.join(root, 'packages', 'magpie-plugin');
  fs.mkdirSync(path.join(root, 'packages', 'core', 'dist'), { recursive: true });
  fs.mkdirSync(plugin, { recursive: true });
  fs.writeFileSync(path.join(root, 'packages', 'core', 'dist', 'cli.js'), '');

  const realRoot = fs.realpathSync(root);
  assert.deepEqual(findGateway(plugin), {
    root: realRoot,
    entry: path.join(realRoot, 'packages', 'core', 'dist', 'cli.js'),
  });
  assert.deepEqual(findGateway(root), {
    root: realRoot,
    entry: path.join(realRoot, 'packages', 'core', 'dist', 'cli.js'),
  });

  const empty = tempDir('wecom-empty-');
  assert.equal(findGateway(empty), null);

  const sourceOnly = tempDir('wecom-source-');
  fs.mkdirSync(path.join(sourceOnly, 'packages', 'core', 'src'), { recursive: true });
  fs.writeFileSync(path.join(sourceOnly, 'packages', 'core', 'src', 'cli.ts'), '');
  if (process.versions.bun) {
    assert.ok(findGateway(sourceOnly), 'Bun runs TypeScript directly');
  } else {
    assert.equal(findGateway(sourceOnly), null, 'Node must not be pointed at a .ts file');
  }

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
  fs.rmSync(sourceOnly, { recursive: true, force: true });
});

test('ensureService does nothing unless the user opted in and a gateway exists', async () => {
  const cache = tempDir('wecom-cache-');
  const empty = tempDir('wecom-nogateway-');
  const port = await unusedPort();
  const notifyUrl = `http://127.0.0.1:${port}/notify`;

  assert.equal(
    await ensureService(
      { autoStartService: false, notifyUrl },
      { startDir: empty, cacheDir: cache, force: true }
    ),
    false
  );
  assert.equal(
    await ensureService(
      { autoStartService: true, notifyUrl },
      { startDir: empty, cacheDir: cache, force: true }
    ),
    false
  );
  assert.equal(
    fs.existsSync(path.join(cache, 'wecom-agent-bridge')),
    false,
    'a missing checkout must not leave a log behind'
  );

  fs.rmSync(cache, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
});

test('an occupied port is never spawned over, healthy or not', async (t) => {
  const root = tempDir('wecom-fake-');
  const cache = tempDir('wecom-cache-');
  fs.mkdirSync(path.join(root, 'packages', 'core', 'dist'), { recursive: true });
  const marker = path.join(root, 'packages', 'core', 'dist', 'spawned.json');
  fs.writeFileSync(
    path.join(root, 'packages', 'core', 'dist', 'cli.js'),
    "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'spawned.json'), '1');"
  );

  let healthy = true;
  const server = http.createServer((req, res) => {
    if (!healthy) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'unavailable' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'wecom-agent-bridge' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const notifyUrl = `http://127.0.0.1:${server.address().port}/notify`;
  assert.equal(
    await ensureService(
      { autoStartService: true, notifyUrl },
      { startDir: root, cacheDir: cache, force: true }
    ),
    false
  );

  // The port is open but the service answers 503: it may be booting, or it
  // may be somebody else's process. Either way, spawning would only race it.
  healthy = false;
  assert.equal(
    await ensureService(
      { autoStartService: true, notifyUrl },
      { startDir: root, cacheDir: cache, force: true }
    ),
    false
  );

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(fs.existsSync(marker), false, 'the host must trust /health or the port, never spawn blindly');

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

test('an unhealthy gateway is spawned with the config path, port and host runtime', async () => {
  const root = tempDir('wecom-fake-');
  const cache = tempDir('wecom-cache-');
  const dist = path.join(root, 'packages', 'core', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), '{}');
  fs.writeFileSync(
    path.join(dist, 'cli.js'),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.writeFileSync(path.join(__dirname, 'spawned.json'), JSON.stringify({",
      '  argv: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '  path: process.env.PATH,',
      '}));',
    ].join('\n')
  );

  const realRoot = fs.realpathSync(root);
  const port = await unusedPort();
  const spawned = await ensureService(
    { autoStartService: true, notifyUrl: `http://127.0.0.1:${port}/notify` },
    { startDir: root, cacheDir: cache, force: true }
  );
  assert.equal(spawned, true);

  const marker = path.join(dist, 'spawned.json');
  assert.equal(await waitFor(() => fs.existsSync(marker)), true, 'the child must run');

  const child = JSON.parse(fs.readFileSync(marker, 'utf-8'));
  assert.deepEqual(child.argv, [
    '--config',
    path.join(realRoot, 'config.json'),
    '--port',
    String(port),
  ]);
  assert.equal(child.cwd, realRoot);
  const localBin = path.join(os.homedir(), '.local', 'bin');
  if (fs.existsSync(localBin)) {
    assert.ok(
      child.path.split(path.delimiter).includes(localBin),
      'agent commands in ~/.local/bin must be reachable from a GUI-launched host'
    );
  }

  const log = fs.readFileSync(serviceLogPath(cache), 'utf-8');
  assert.match(log, /\] start /);
  assert.match(log, new RegExp(`--port ${port}`));

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(cache, { recursive: true, force: true });
});

test('the service log lives under the cache directory', () => {
  assert.equal(
    serviceLogPath('/tmp/example-cache'),
    '/tmp/example-cache/wecom-agent-bridge/service.log'
  );
});
