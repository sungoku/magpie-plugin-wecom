import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  publicConfig,
  sanitizeBots,
  saveConfig,
  type BotConfig,
  type BridgeConfig,
} from '../src/config.js';

const agents = {
  claude: { type: 'cli' as const, command: 'claude -p "{prompt}"' },
  sh: { type: 'cli' as const, command: '{prompt}' },
};

const existing: BotConfig[] = [
  {
    id: 'bot-1',
    name: '旧 Bot',
    botId: 'old-bot-id',
    secret: 'old-super-secret',
    defaultAgent: 'claude',
    allowedUsers: ['alice'],
    promptPrefix: 'old prefix',
  },
];

test('sanitizeBots keeps the secret on disk when the UI sends an empty one', () => {
  const bots = sanitizeBots(
    [{ id: 'bot-1', name: '新名字', botId: 'new-bot-id', secret: '', defaultAgent: 'claude' }],
    existing,
    agents
  );
  assert.equal(bots.length, 1);
  assert.equal(bots[0].secret, 'old-super-secret');
  assert.equal(bots[0].name, '新名字');
  assert.equal(bots[0].botId, 'new-bot-id');
});

test('sanitizeBots keeps the secret when the UI echoes the masked placeholder', () => {
  const bots = sanitizeBots(
    [{ id: 'bot-1', secret: 'old••••cret', defaultAgent: 'claude' }],
    existing,
    agents
  );
  assert.equal(bots[0].secret, 'old-super-secret');
});

test('sanitizeBots accepts a genuinely new secret', () => {
  const bots = sanitizeBots(
    [{ id: 'bot-1', secret: 'brand-new-secret', defaultAgent: 'claude' }],
    existing,
    agents
  );
  assert.equal(bots[0].secret, 'brand-new-secret');
});

test('sanitizeBots never lets a new bot inherit another bot secret', () => {
  const bots = sanitizeBots(
    [{ id: '', name: '新 Bot', botId: '', defaultAgent: 'claude' }],
    existing,
    agents
  );
  assert.equal(bots.length, 1);
  assert.equal(bots[0].secret, '');
  assert.notEqual(bots[0].id, 'bot-1');
});

test('sanitizeBots rejects a non-array and bounds values', () => {
  assert.throws(() => sanitizeBots({}, existing, agents), /数组/);
  const bots = sanitizeBots(
    [{
      id: 'x',
      name: 'n'.repeat(500),
      botId: 'b'.repeat(500),
      defaultAgent: 'not-an-agent',
      allowedUsers: ['u1', 'u1', 42, 'u2'],
      promptPrefix: 'p'.repeat(9000),
    }],
    [],
    agents
  );
  assert.equal(bots[0].name.length, 80);
  assert.equal(bots[0].botId.length, 256);
  assert.equal(bots[0].defaultAgent, 'claude');
  assert.deepEqual(bots[0].allowedUsers, ['u1', 'u2']);
  assert.equal(bots[0].promptPrefix?.length, 8000);
});

test('publicConfig never exposes a secret', () => {
  const config: BridgeConfig = {
    defaultAgent: 'claude',
    agents,
    bots: existing,
    wecom: { botId: 'legacy-id', secret: 'legacy-secret' },
  };
  const safe = publicConfig(config);
  const json = JSON.stringify(safe);
  assert.ok(!json.includes('old-super-secret'));
  assert.ok(!json.includes('legacy-secret'));
  assert.equal(safe.bots[0].secretSet, true);
  assert.ok(safe.bots[0].secretMasked.includes('••••'));
  assert.equal((safe.bots[0] as any).secret, undefined);
  assert.equal((safe as any).wecom, undefined);
});

test('saving a bot list retires the legacy wecom block (no resurrection)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-config-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      wecom: { botId: 'legacy-id', secret: 'legacy-secret' },
      defaultAgent: 'claude',
      agents,
      server: { port: 19099, host: '127.0.0.1' },
    })
  );

  try {
    // The legacy block is still converted for old configs...
    const loaded = loadConfig(file);
    assert.equal(loaded.bots.length, 1);
    assert.equal(loaded.bots[0].secret, 'legacy-secret');

    // ...but once the new list is saved, deleting the bot sticks.
    saveConfig({ ...loaded, bots: [] }, file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(raw.wecom, undefined);
    assert.deepEqual(loadConfig(file).bots, []);

    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
