import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = fs.readFileSync(path.resolve(here, '../page/app.js'), 'utf-8');

/** The small slice of the DOM that the Magpie-mode branch touches. */
function makeElement(id) {
  return {
    id,
    value: '',
    checked: false,
    textContent: '',
    className: '',
    hidden: true,
    disabled: false,
    dataset: {},
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    fire(type) {
      return Promise.all((this.listeners[type] || []).map((fn) => fn({ target: this })));
    },
  };
}

test('the Magpie-mode page reads, clamps and saves options through the bridge', async () => {
  const ids = [
    'magpie-panel',
    'subtitle',
    'mg-enabled',
    'mg-min-duration',
    'mg-approval-wait',
    'mg-notify-url',
    'mg-autostart',
    'mg-status',
    'mg-save',
    'mg-service-url',
    'mg-open',
    'toast',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, makeElement(id)]));

  const saved = [];
  const opened = [];
  let fetched = 0;
  const options = {
    enabled: true,
    minDurationSec: 3,
    notifyUrl: 'http://127.0.0.1:9099/notify',
    gatewayTimeoutMs: 2500,
  };

  const document = {
    body: { dataset: {} },
    getElementById: (id) => elements[id] || null,
  };

  const window = {
    document,
    magpie: {
      ready: Promise.resolve({}),
      options: {
        get: async () => ({ ...options }),
        set: async (next) => {
          saved.push(next);
          return next;
        },
      },
    },
    location: {
      assign(url) {
        opened.push(url);
      },
    },
  };

  const context = {
    window,
    document,
    URL,
    Number,
    Promise,
    Object,
    String,
    setTimeout: (fn) => {
      queueMicrotask(fn);
      return 1;
    },
    clearTimeout: () => {},
    fetch: async () => {
      fetched++;
      throw new Error('the Magpie page must not fetch');
    },
    console,
  };
  vm.createContext(context);
  vm.runInContext(app, context, { filename: 'app.js' });

  // Let the bridge's options.get and the initial render settle.
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements['magpie-panel'].hidden, false);
  assert.equal(window.document.body.dataset.mode, 'magpie');
  assert.equal(elements['mg-enabled'].checked, true);
  assert.equal(Number(elements['mg-min-duration'].value), 3);
  assert.equal(Number(elements['mg-approval-wait'].value), 10);
  assert.equal(elements['mg-notify-url'].value, 'http://127.0.0.1:9099/notify');
  assert.equal(elements['mg-autostart'].checked, false, 'auto-start is opt-in');
  assert.equal(elements['mg-service-url'].value, 'http://127.0.0.1:9099/');

  // Out-of-range values are clamped and the URL is trimmed.
  elements['mg-enabled'].checked = false;
  elements['mg-min-duration'].value = '9999';
  elements['mg-approval-wait'].value = '999';
  elements['mg-notify-url'].value = '  http://127.0.0.1:1234/notify  ';
  elements['mg-autostart'].checked = true;
  await elements['mg-save'].fire('click');

  assert.equal(saved.length, 1);
  assert.equal(saved[0].enabled, false);
  assert.equal(saved[0].minDurationSec, 3600);
  assert.equal(saved[0].approvalWaitSec, 300);
  assert.equal(saved[0].notifyUrl, 'http://127.0.0.1:1234/notify');
  assert.equal(saved[0].autoStartService, true);
  assert.equal(saved[0].gatewayTimeoutMs, 2500, 'unrelated options must be preserved');
  assert.match(elements['mg-status'].textContent, /已保存/);
  assert.equal(elements['mg-save'].disabled, false);
  assert.equal(fetched, 0);

  await elements['mg-open'].fire('click');
  assert.deepEqual(opened, ['http://127.0.0.1:1234/']);
});
