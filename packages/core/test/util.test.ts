import test from 'node:test';
import assert from 'node:assert/strict';
import { clampInt, looksMasked, maskSecret, truncateUtf8 } from '../src/util.js';

test('truncateUtf8 leaves short text untouched', () => {
  assert.equal(truncateUtf8('hello', 100), 'hello');
});

test('truncateUtf8 never splits a multi-byte character', () => {
  const text = '企业微信'.repeat(100);
  const out = truncateUtf8(text, 120);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 120);
  assert.ok(out.includes('…'));
  // No replacement characters from a broken code point.
  assert.ok(!out.includes('�'));
});

test('truncateUtf8 keeps both ends by default and the head in head mode', () => {
  const text = 'HEAD' + 'x'.repeat(1000) + 'TAIL';
  const both = truncateUtf8(text, 200);
  assert.ok(both.startsWith('HEAD'));
  assert.ok(both.endsWith('TAIL'));
  const head = truncateUtf8(text, 200, 'head');
  assert.ok(head.startsWith('HEAD'));
  assert.ok(!head.endsWith('TAIL'));
});

test('maskSecret never exposes a short secret', () => {
  assert.equal(maskSecret(''), '');
  assert.equal(maskSecret('short'), '••••••••');
  const masked = maskSecret('abcdefghijklmnop');
  assert.equal(masked, 'abc••••nop');
  assert.ok(looksMasked(masked));
  assert.ok(!looksMasked('a-real-secret'));
});

test('clampInt bounds and falls back safely', () => {
  assert.equal(clampInt('5', 0, 10, 3), 5);
  assert.equal(clampInt('-5', 0, 10, 3), 0);
  assert.equal(clampInt('50', 0, 10, 3), 10);
  assert.equal(clampInt('nope', 0, 10, 3), 3);
});
