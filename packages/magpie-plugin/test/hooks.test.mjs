import test from 'node:test';
import assert from 'node:assert/strict';
import { hasToolCalls, onRequest, onResponse, replyText, toolCallsOf } from '../wecom.hooks.js';

const realFetch = globalThis.fetch;

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return { ok: true };
  };
  return calls;
}

function restore() {
  globalThis.fetch = realFetch;
}

const baseOptions = {
  enabled: true,
  minDurationSec: 0,
  approvalWaitSec: 0,
  notifyUrl: 'http://127.0.0.1:19099/notify',
};

test('notifies on a final chat completion', async (t) => {
  const calls = stubFetch();
  t.after(restore);
  await onResponse(
    { choices: [{ finish_reason: 'stop', message: { content: 'done!' } }] },
    { protocol: 'chat', model: 'm-chat', query: 'build it', session: 's-chat', options: baseOptions }
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.title, /m-chat/);
  assert.match(calls[0].body.content, /done!/);
  assert.match(calls[0].body.content, /build it/);
});

test('does not notify while the agent is still calling tools', async (t) => {
  const calls = stubFetch();
  t.after(restore);

  await onResponse(
    { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: '1' }] } }] },
    { protocol: 'chat', model: 'm', query: 'tool turn', session: 's-tool-1', options: baseOptions }
  );
  await onResponse(
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'bash' }] },
    { protocol: 'anthropic', model: 'm', query: 'tool turn', session: 's-tool-2', options: baseOptions }
  );
  await onResponse(
    { output: [{ type: 'function_call', name: 'shell' }] },
    { protocol: 'responses', model: 'm', query: 'tool turn', session: 's-tool-3', options: baseOptions }
  );
  await onResponse(
    { candidates: [{ content: { parts: [{ functionCall: { name: 'go' } }] } }] },
    { protocol: 'gemini', model: 'm', query: 'tool turn', session: 's-tool-4', options: baseOptions }
  );

  assert.equal(calls.length, 0);
});

test('notifies on a final Anthropic answer', async (t) => {
  const calls = stubFetch();
  t.after(restore);
  await onResponse(
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'all good' }] },
    { protocol: 'anthropic', model: 'claude', query: 'q', session: 's-anthropic', options: baseOptions }
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.content, /all good/);
});

test('honours enabled=false', async (t) => {
  const calls = stubFetch();
  t.after(restore);
  await onResponse(
    { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] },
    { protocol: 'chat', model: 'm', query: 'q', session: 's-off', options: { ...baseOptions, enabled: false } }
  );
  assert.equal(calls.length, 0);
});

test('honours minDurationSec when a start time is known', async (t) => {
  const calls = stubFetch();
  t.after(restore);
  const ctx = {
    protocol: 'chat',
    model: 'm',
    query: 'q',
    session: 's-duration',
    options: { ...baseOptions, minDurationSec: 999 },
  };
  await onRequest({}, ctx);
  await onResponse(
    { choices: [{ finish_reason: 'stop', message: { content: 'too fast' } }] },
    ctx
  );
  assert.equal(calls.length, 0);
});

test('times the whole turn across tool and side-call requests', async (t) => {
  const calls = stubFetch();
  t.after(restore);
  const options = { ...baseOptions, minDurationSec: 0.05, approvalWaitSec: 0 };
  const session = 's-turn-total';

  await onRequest({}, { protocol: 'anthropic', model: 'm', query: 'do the task', session, options });
  await new Promise((resolve) => setTimeout(resolve, 80));

  // A client tool call is an intermediate reply and must not end the turn.
  await onResponse(
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } }],
    },
    { protocol: 'anthropic', model: 'm', query: 'do the task', session, options }
  );

  // A side call shares the session but must not reset the turn start.
  await onRequest(
    { messages: [{ role: 'user', content: '[SUGGESTION MODE: predict]' }] },
    { protocol: 'anthropic', model: 'm', query: '[SUGGESTION MODE: predict]', session, options }
  );

  // The final request has its own ctx/state, but the session's turn start
  // is still the first request.
  const last = { protocol: 'anthropic', model: 'm', query: 'do the task', session, options };
  await onRequest(
    {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }],
      }],
    },
    last
  );
  await onResponse(
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
    last
  );

  assert.equal(calls.length, 1, 'the whole turn must pass the minimum duration, not just the last request');
});

test('deduplicates a repeated onResponse for the same run', async (t) => {
  const calls = stubFetch();
  t.after(restore);
  const ctx = {
    protocol: 'chat',
    model: 'm',
    query: 'q',
    session: 's-dedupe',
    options: baseOptions,
  };
  const reply = { choices: [{ finish_reason: 'stop', message: { content: 'once' } }] };
  await onResponse(reply, ctx);
  await onResponse(reply, ctx);
  assert.equal(calls.length, 1);
});

test('bounds the notification wait with gatewayTimeoutMs', async (t) => {
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  // AbortSignal.timeout's timer is unref'd; keep the test's loop alive until
  // it fires so the runner does not cancel the pending assertion.
  const keepAlive = setTimeout(() => {}, 500);
  t.after(() => {
    clearTimeout(keepAlive);
    restore();
  });

  const started = Date.now();
  await onResponse(
    { choices: [{ finish_reason: 'stop', message: { content: 'slow' } }] },
    {
      protocol: 'chat',
      model: 'm',
      query: 'q',
      options: { ...baseOptions, gatewayTimeoutMs: 100 },
    }
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `onResponse must not wait ${elapsed}ms for a dead service`);
});

test('two identical-looking requests are independent', async (t) => {
  const calls = stubFetch();
  t.after(restore);
  const reply = { choices: [{ finish_reason: 'stop', message: { content: 'twice' } }] };
  for (const session of ['s-a', 's-a']) {
    const ctx = { protocol: 'chat', model: 'm', query: 'q', session, options: baseOptions };
    await onRequest({}, ctx);
    await onResponse(reply, ctx);
  }
  assert.equal(calls.length, 2);
});

test('ignores a run the gateway reports as unsuccessful', async (t) => {
  const calls = stubFetch();
  t.after(restore);
  await onResponse(
    { choices: [{ finish_reason: 'stop', message: { content: 'partial' } }] },
    { protocol: 'chat', model: 'm', query: 'q', session: 's-failed', success: false, options: baseOptions }
  );
  assert.equal(calls.length, 0);
});

test('ignores error replies', async (t) => {
  const calls = stubFetch();
  t.after(restore);
  await onResponse(
    { error: { message: 'boom' } },
    { protocol: 'chat', model: 'm', query: 'q', session: 's-error', options: baseOptions }
  );
  assert.equal(calls.length, 0);
});

test('tool-call and text extraction cover the supported protocols', () => {
  assert.equal(hasToolCalls({ choices: [{ message: { tool_calls: [{}] } }] }, 'chat'), true);
  assert.equal(hasToolCalls({ stop_reason: 'tool_use' }, 'anthropic'), true);
  assert.equal(hasToolCalls({ content: [{ type: 'server_tool_use', name: 'web_search' }] }, 'anthropic'), true);
  assert.equal(hasToolCalls({ output: [{ type: 'function_call' }] }, 'responses'), true);
  assert.equal(hasToolCalls({ output: [{ type: 'web_search_call' }] }, 'responses'), true);
  assert.equal(hasToolCalls({ candidates: [{ content: { parts: [{ functionCall: {} }] } }] }, 'gemini'), true);
  assert.equal(hasToolCalls({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }, 'chat'), false);

  assert.equal(replyText({ choices: [{ message: { content: 'a' } }] }), 'a');
  assert.equal(replyText({ content: [{ type: 'text', text: 'b' }] }), 'b');
  assert.equal(replyText({ output_text: 'c' }), 'c');
  assert.equal(replyText({ candidates: [{ content: { parts: [{ text: 'd' }] } }] }), 'd');

  // Thinking must never be mistaken for the answer.
  assert.equal(
    replyText({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'shown' }] }),
    'shown'
  );
  assert.equal(
    replyText({ candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: 'shown' }] } }] }),
    'shown'
  );
  assert.equal(
    replyText({
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'hidden' }] },
        { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: 'shown' }] },
      ],
    }),
    'shown'
  );
});

test('tool calls are tagged as client-run or server-run', () => {
  const anthropic = toolCallsOf({
    content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } },
    ],
  });
  assert.deepEqual(anthropic.map((c) => [c.name, c.client]), [['Bash', true], ['web_search', false]]);

  const responses = toolCallsOf({
    output: [
      { type: 'function_call', call_id: 'f1', name: 'shell', arguments: '{"command":"ls"}' },
      { type: 'web_search_call', id: 'w1', action: { query: 'x' } },
    ],
  });
  assert.deepEqual(responses.map((c) => [c.name, c.client]), [['shell', true], ['web_search_call', false]]);
  assert.deepEqual(responses[0].input, { command: 'ls' }, 'JSON arguments are parsed');
});

test('keeps the full final answer instead of a 300-character preview', async (t) => {
  const calls = stubFetch();
  t.after(restore);
  const tail = 'TAIL-MARKER-1234567890';
  const answer = `${'line of the answer\n'.repeat(80)}${tail}`;

  await onResponse(
    { choices: [{ finish_reason: 'stop', message: { content: answer } }] },
    { protocol: 'chat', model: 'm', query: 'q', session: 's-full', options: baseOptions }
  );

  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.content.length > answer.length * 0.9, 'the answer must not be cut to 300 chars');
  assert.match(calls[0].body.content, /line of the answer\nline of the answer/);
  assert.ok(calls[0].body.content.includes(tail), 'the end of the answer must be present');
});

test('skips Claude Code WebSearch and prompt-suggestion side calls', async (t) => {
  const calls = stubFetch();
  t.after(restore);

  await onResponse(
    { content: [{ type: 'text', text: 'Search results summary…' }] },
    {
      protocol: 'anthropic',
      model: 'm',
      query: 'Perform a web search for the query: magpie plugin options',
      session: 's-side-search',
      options: baseOptions,
      request: {
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
          { type: 'text', text: 'You are an assistant for performing a web search tool use' },
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: 'Perform a web search for the query: magpie plugin options' }],
      },
    }
  );

  await onResponse(
    { content: [{ type: 'text', text: 'Suggested next input' }] },
    {
      protocol: 'anthropic',
      model: 'm',
      query: '[SUGGESTION MODE: predict the next user message]',
      session: 's-side-suggest',
      options: baseOptions,
    }
  );

  assert.equal(calls.length, 0);
});

test('notifies the final answer when the same reply also carries a server tool call', async (t) => {
  const calls = stubFetch();
  t.after(restore);

  await onResponse(
    {
      stop_reason: 'end_turn',
      content: [
        { type: 'text', text: 'I will search first.' },
        { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'go' } },
        { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] },
        { type: 'text', text: 'Final answer after search.' },
      ],
    },
    { protocol: 'anthropic', model: 'm', query: 'q', session: 's-server-final', options: baseOptions }
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].body.content, /Final answer after search/);
  assert.doesNotMatch(calls[0].body.content, /I will search first/, 'only the text after the last tool step is the answer');
});

test('does not notify a server tool round that has no answer text yet', async (t) => {
  const calls = stubFetch();
  t.after(restore);

  await onResponse(
    { content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'go' } }] },
    { protocol: 'anthropic', model: 'm', query: 'q', session: 's-server-only', options: baseOptions }
  );

  assert.equal(calls.length, 0);
});

test('never sends thinking or reasoning as the result', async (t) => {
  const calls = stubFetch();
  t.after(restore);

  await onResponse(
    {
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'internal chain of thought' },
        { type: 'text', text: 'Visible answer.' },
      ],
    },
    { protocol: 'anthropic', model: 'm', query: 'q', session: 's-think-a', options: baseOptions }
  );
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].body.content, /internal chain of thought/);
  assert.match(calls[0].body.content, /Visible answer/);

  await onResponse(
    {
      candidates: [{
        content: {
          parts: [{ thought: true, text: 'gemini private thoughts' }, { text: 'Gemini answer' }],
        },
      }],
    },
    { protocol: 'gemini', model: 'm', query: 'q', session: 's-think-b', options: baseOptions }
  );
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].body.content, /gemini private thoughts/);
  assert.match(calls[1].body.content, /Gemini answer/);
});

test('reminds the user when a tool call is likely waiting for approval or selection', async (t) => {
  const calls = stubFetch();
  t.after(restore);

  const ctx = {
    protocol: 'anthropic',
    model: 'm',
    query: 'pick a plan',
    session: 's-approval-ask',
    options: { ...baseOptions, approvalWaitSec: 0.1 },
  };
  await onResponse(
    {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use',
        id: 'toolu_ask',
        name: 'AskUserQuestion',
        input: {
          questions: [{
            question: '选哪个方案？',
            header: '方案',
            options: [{ label: 'A' }, { label: 'B' }],
            multiSelect: false,
          }],
        },
      }],
    },
    ctx
  );

  assert.equal(calls.length, 0, 'a tool-call reply is not a completed task');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.title, /等待你的选择/);
  assert.match(calls[0].body.content, /选哪个方案？/);
  assert.match(calls[0].body.content, /A \/ B/);
  assert.match(calls[0].body.content, /pick a plan/);
});

test('cancels the approval reminder as soon as the session sends its next request', async (t) => {
  const calls = stubFetch();
  t.after(restore);

  const ctx = {
    protocol: 'anthropic',
    model: 'm',
    query: 'run it',
    session: 's-approval-cancel',
    options: { ...baseOptions, approvalWaitSec: 0.1 },
  };
  await onResponse(
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls' } }],
    },
    ctx
  );
  await onRequest(
    {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'ok' }],
      }],
    },
    ctx
  );

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(calls.length, 0);
});

test('a prompt-suggestion side call does not cancel a pending approval reminder', async (t) => {
  const calls = stubFetch();
  t.after(restore);

  const ctx = {
    protocol: 'anthropic',
    model: 'm',
    query: 'run it',
    session: 's-approval-side',
    options: { ...baseOptions, approvalWaitSec: 0.1 },
  };
  await onResponse(
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_ask_2', name: 'AskUserQuestion', input: { questions: [{ question: '继续吗？', options: [{ label: '是' }, { label: '否' }] }] } }],
    },
    ctx
  );

  await onRequest(
    { messages: [{ role: 'user', content: '[SUGGESTION MODE: predict the next message]' }] },
    { ...ctx, query: '[SUGGESTION MODE: predict the next message]' }
  );

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(calls.length, 1, 'the side call must leave the approval timer running');
  assert.match(calls[0].body.title, /等待你的选择/);
});

test('approvalWaitSec=0 disables the reminder', async (t) => {
  const calls = stubFetch();
  t.after(restore);

  await onResponse(
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'toolu_write', name: 'Write', input: { file_path: '/tmp/x' } }],
    },
    {
      protocol: 'anthropic',
      model: 'm',
      query: 'write it',
      session: 's-approval-off',
      options: { ...baseOptions, approvalWaitSec: 0 },
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(calls.length, 0);
});
