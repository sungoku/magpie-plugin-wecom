import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCommand, shellQuote } from '../src/adapters/cli-adapter.js';

test('shellQuote neutralises command substitution and backticks', () => {
  const quoted = shellQuote('$(rm -rf /) `whoami`; echo pwned');
  assert.equal(quoted, "'$(rm -rf /) `whoami`; echo pwned'");
  // A single quote inside the prompt is escaped as '\''.
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('buildCommand quotes prompts for double-quoted templates', () => {
  assert.equal(
    buildCommand('claude -p "{prompt}"', 'hello $(whoami)'),
    "claude -p 'hello $(whoami)'"
  );
});

test('buildCommand quotes prompts for single-quoted templates', () => {
  assert.equal(
    buildCommand("opencode run '{prompt}'", "it's fine"),
    "opencode run 'it'\\''s fine'"
  );
});

test('buildCommand quotes bare placeholders and appends when absent', () => {
  assert.equal(buildCommand('agent --prompt={prompt}', 'a b'), "agent --prompt='a b'");
  assert.equal(buildCommand('agent', 'a b'), "agent 'a b'");
});

test('buildCommand keeps the explicit raw-shell agent', () => {
  // The `sh` agent is intentionally raw: the prompt is the command.
  assert.equal(buildCommand('{prompt}', 'git status && ls'), 'git status && ls');
  assert.equal(buildCommand('  {prompt}  ', 'pwd'), 'pwd');
});
