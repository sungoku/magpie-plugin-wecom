/**
 * Magpie 异步网关钩子（运行在 Bun 插件宿主里）
 *
 * 为什么不是 middleware：Magpie 的网关中间件跑在 moejs 里，文档明确说明
 * 没有 fetch、没有定时器、也没有 Node API，因此无法访问本地通知服务。
 * 异步网关钩子 (`magpie.hooks`) 跑在 Bun 里，可以使用 fetch 和定时器。
 *
 * 职责：
 *  - Agent 一轮请求完成后，向本机 wecom-agent-bridge 的 /notify 推送耗时与
 *    **完整**结果摘要（按 UTF-8 字节上限截断，不再截成 300 字）。
 *  - 跳过 Claude Code 的内部侧调用（WebSearch 的“Perform a web search…”、
 *    [SUGGESTION MODE] 等），避免把搜索结果摘要当成任务结果推送。
 *  - 只跳过“还需要客户端继续跑”的 tool_use；服务端工具（web_search）与最终
 *    文本同在一轮时，仍然推送最终文本。
 *  - 客户端工具调用后若长时间没有下一步请求，推送“可能在等待确认/选择”提醒。
 *
 * 零 npm 依赖；仅在同目录的 service.js 里使用 Node 内置模块。
 */
import { ensureService } from './service.js';

const DEFAULT_NOTIFY_URL = 'http://127.0.0.1:9099/notify';
const DEFAULT_MIN_DURATION_SEC = 3;
const DEFAULT_APPROVAL_WAIT_SEC = 10;
const FETCH_TIMEOUT_MS = 3000;
const MAX_RESULT_BYTES = 18_000;
/** A turn abandoned mid-tool must not lend its start to a task an hour later. */
const TURN_STALE_MS = 30 * 60 * 1000;

/**
 * Client tools that never leave the client waiting for a human: the fast
 * read-only lookups and Claude Code's own WebSearch (a long search must not
 * look like a permission prompt). Read is deliberately absent: reading a
 * file outside the workspace can prompt. Every other client tool is
 * treated as a possible permission/selection prompt, so a new or MCP tool
 * is covered too.
 */
const AUTO_TOOLS = new Set([
  'glob', 'grep', 'ls', 'notebookread',
  'todowrite', 'todoread', 'bashoutput', 'killshell',
  'websearch',
]);

/**
 * Per-session pending confirmation. `setTimeout` lives in the long-lived Bun
 * host, not in the request: it keeps running after onResponse returns and is
 * cancelled by the next request for the same session.
 * @type {Map<string, { timer: any, callIds: string[], options: object, ctx: object, calls: object[], delaySec: number }>}
 */
const pendingApprovals = new Map();

/**
 * Turn start per session. Claude Code splits one task across several requests
 * (tool rounds, WebSearch, the final answer), and the final answer request is
 * often faster than minDurationSec. Timing the whole turn keeps a real task
 * from being filtered as "too short"; a final reply (or an error) ends it.
 * @type {Map<string, number>}
 */
const sessionStarts = new Map();

/**
 * The host hands the same `ctx.state` to onRequest and onResponse for one
 * request, so timing lives there instead of in a module-level map: two
 * concurrent requests can share a session/query/model and still stay apart,
 * and nothing has to be pruned. A WeakMap is only a fallback for a host that
 * omits ctx.state.
 * @type {WeakMap<object, { start?: number, query?: string, model?: string, notified?: boolean }>}
 */
const fallbackStates = new WeakMap();

function stateOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return {};
  if (ctx.state && typeof ctx.state === 'object') return ctx.state;
  let state = fallbackStates.get(ctx);
  if (!state) {
    state = {};
    fallbackStates.set(ctx, state);
  }
  return state;
}

/** onRequest: remembers the turn start; never changes the body. */
export async function onRequest(body, ctx) {
  try {
    const state = stateOf(ctx);
    // A Claude Code side call is not the start of a user turn. Keep the
    // current turn's start if there is one, and do not create one otherwise.
    const side = isSideCallRequest(body, ctx);
    state.start = side ? sessionStarts.get(pendingKey(ctx)) : turnStartOf(ctx);
    state.query = typeof ctx?.query === 'string' ? ctx.query : '';
    state.model = typeof ctx?.model === 'string' ? ctx.model : '';
  } catch {
    // fail open: never disturb the request
  }

  // Any new request for this session means the client moved past the tool
  // call (the approval prompt was answered, or an auto-approved tool ran).
  // Claude Code can send a prompt-suggestion request while a permission
  // prompt is open, so a side call must not cancel the pending reminder.
  try {
    if (!isSideCallRequest(body, ctx)) cancelApprovalWait(ctx);
  } catch {
    // fail open
  }

  // If the user opted in, revive the local gateway when it is down. This is
  // deliberately fire-and-forget: an Agent request must never wait for it.
  try {
    ensureService(ctx?.options || {}).catch(() => {});
  } catch {
    // fail open
  }
  return undefined;
}

/** onResponse: pushes one notification for a finished, non-tool-call reply. */
export async function onResponse(reply, ctx) {
  try {
    const options = ctx?.options || {};

    // Claude Code's internal side calls are not the user's task: the
    // WebSearch one answers with the search result summary, and the
    // suggestion one guesses the user's next input. Pushing either looked
    // like an incomplete "task completed" message.
    if (isSideCall(ctx)) return undefined;

    // A non-side reply means this session is no longer waiting on the
    // previous tool call, even if an error or filter ends the turn here.
    cancelApprovalWait(ctx);

    if (options.enabled === false) return undefined;
    if (isErrorReply(reply)) {
      endTurn(ctx);
      return undefined;
    }

    const calls = toolCallsOf(reply, ctx?.protocol);
    const clientCalls = calls.filter((call) => call.client);
    if (clientCalls.length) {
      // The client must run these tools before the model can answer. Do not
      // notify yet; if no next request arrives, say it may be waiting.
      // Arm before the success check: a client that stops reading at the
      // tool_use block can leave the gateway's recorded stream incomplete,
      // and that is exactly when the human prompt is on screen.
      armApprovalWait(clientCalls, ctx, options);
      return undefined;
    }

    // A protocol said tool_calls but the body carried no parseable call:
    // still an intermediate round.
    if (hasToolCalls(reply, ctx?.protocol) && calls.length === 0) return undefined;

    // Server tools (web_search, file_search, …) may be in the same reply as
    // the final answer. If there is visible text, that text is the answer.
    const text = stripReasoning(replyText(reply)).trim();
    if (calls.length && !text) return undefined;

    // The turn is over even if an option below suppresses the notification;
    // the next user request must not inherit this turn's start time.
    endTurn(ctx);

    if (ctx?.success === false) return undefined;

    const state = stateOf(ctx);
    if (state.notified) return undefined;

    const now = Date.now();
    const started = Number.isFinite(state.start);
    const durationMs = started ? Math.max(0, now - state.start) : 0;
    const durationSec = Math.round(durationMs / 1000);
    const minDuration = numberOption(options.minDurationSec, DEFAULT_MIN_DURATION_SEC, 0, 3600);
    if (started && durationMs < minDuration * 1000) return undefined;

    const notifyUrl = stringOption(options.notifyUrl, DEFAULT_NOTIFY_URL);
    if (!/^https?:\/\//i.test(notifyUrl)) return undefined;
    const timeoutMs = numberOption(options.gatewayTimeoutMs, FETCH_TIMEOUT_MS, 100, 10_000);
    // Set before awaiting fetch: a second onResponse for this same run must
    // not push twice, and it must not wait for the first one either.
    state.notified = true;

    const query = truncate(
      (state.query || ctx?.query || '').replace(/\s+/g, ' ').trim(),
      160
    );
    const model = state.model || ctx?.model || 'unknown-model';
    const agent = typeof ctx?.agent === 'string' ? ctx.agent : '';
    const summary = truncateBytes(text, MAX_RESULT_BYTES);

    const lines = [`⏱️ **耗时**: ${durationSec} 秒`];
    if (query) lines.push(`🎯 **任务**: ${query}`);
    if (agent) lines.push(`🤖 **Agent**: ${agent}`);
    lines.push('', '📝 **结果**:', '', summary || '无文本回显');

    await postJson(
      notifyUrl,
      {
        title: `🎉 Agent 任务已完成 (${model})`,
        content: lines.join('\n'),
      },
      ctx?.signal,
      timeoutMs
    );
  } catch {
    // The gateway must never wait on or fail because of a notification.
  }
  return undefined;
}

/**
 * All tool calls in a completed reply, tagged with whether the client must
 * run them (true) or the server already did (false).
 *
 * @returns {{ id: string, name: string, input: unknown, client: boolean }[]}
 */
export function toolCallsOf(reply, protocol) {
  const out = [];
  const seen = new Set();
  const add = (id, name, input, client = true) => {
    const key = `${String(id || '')}|${String(name || '')}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    out.push({ id: String(id || ''), name: String(name), input, client });
  };
  if (!reply || typeof reply !== 'object') return out;

  // Anthropic Messages
  if (Array.isArray(reply.content)) {
    for (const block of reply.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') add(block.id, block.name, block.input, true);
      else if (block.type === 'server_tool_use') add(block.id, block.name, block.input, false);
    }
  }
  if (reply.type === 'tool_use') add(reply.id, reply.name, reply.input, true);

  // OpenAI Responses: any *_call item is a tool step; the named client
  // ones are run by the client, the rest (web_search, file_search, …) by
  // the server and may share the reply with the final answer.
  if (Array.isArray(reply.output)) {
    const clientTypes = new Set([
      'function_call', 'custom_tool_call', 'computer_call',
      'mcp_call', 'local_shell_call',
    ]);
    for (const item of reply.output) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.type !== 'string' || !item.type.endsWith('_call')) continue;
      add(
        item.call_id || item.id,
        item.name || item.type,
        parseArguments(item.arguments ?? item.input ?? item.action),
        clientTypes.has(item.type)
      );
    }
  }

  // Gemini
  const parts = reply.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const call = part?.functionCall || part?.function_call;
      if (!call) continue;
      add(call.id, call.name, call.args || call.arguments, true);
    }
  }

  // OpenAI Chat Completions
  const choice = reply.choices?.[0];
  if (choice?.message) {
    for (const call of choice.message.tool_calls || []) {
      add(call.id, call.function?.name || call.name, parseArguments(call.function?.arguments ?? call.arguments), true);
    }
    if (choice.message.function_call) {
      const call = choice.message.function_call;
      add(call.id, call.name, parseArguments(call.arguments), true);
    }
  }

  // Keep the protocol argument meaningful for callers and future shapes.
  void protocol;
  return out;
}

/** True when the reply is an intermediate tool round (any tool, client or server). */
export function hasToolCalls(reply, protocol) {
  if (!reply || typeof reply !== 'object') return false;

  // Anthropic Messages
  if (reply.stop_reason === 'tool_use') return true;
  if (Array.isArray(reply.content)) {
    if (reply.content.some((b) => b && (b.type === 'tool_use' || b.type === 'server_tool_use'))) {
      return true;
    }
  }

  // OpenAI Responses
  if (Array.isArray(reply.output)) {
    if (reply.output.some((item) =>
      item && typeof item.type === 'string' && item.type.endsWith('_call')
    )) {
      return true;
    }
  }

  // Gemini
  const parts = reply.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts) && parts.some((p) => p && (p.functionCall || p.function_call))) {
    return true;
  }

  // OpenAI Chat Completions
  const choice = reply.choices?.[0];
  if (choice) {
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') return true;
    if (choice.message?.tool_calls?.length) return true;
    if (choice.message?.function_call) return true;
  }

  // Last resort: the caller told us the protocol but the body is flat.
  if (protocol === 'anthropic' && reply.type === 'tool_use') return true;
  return false;
}

/** The visible assistant text, excluding thinking/reasoning blocks. */
export function replyText(reply) {
  if (!reply || typeof reply !== 'object') return '';

  const choice = reply.choices?.[0];
  if (choice?.message) {
    return contentToText(choice.message.content);
  }
  if (Array.isArray(reply.content)) {
    // Anthropic may put a short preamble before a tool step and the answer
    // after its result. Only the text after the last tool block is the answer.
    let start = 0;
    for (let i = reply.content.length - 1; i >= 0; i--) {
      const type = reply.content[i]?.type;
      if (
        type === 'tool_use' || type === 'server_tool_use' ||
        type === 'web_search_tool_result' || type === 'tool_result'
      ) {
        start = i + 1;
        break;
      }
    }
    return contentToText(reply.content.slice(start));
  }
  if (typeof reply.output_text === 'string') return reply.output_text;
  if (Array.isArray(reply.output)) {
    const messages = reply.output.filter((item) => item && item.type === 'message');
    // Responses can carry a short commentary message before the tool call
    // and the real answer after it. Prefer the marked final answer and
    // never turn commentary alone into a "task completed" result.
    const final = messages.filter((item) => item.phase === 'final_answer');
    const chosen = final.length
      ? final
      : messages.filter((item) => item.phase !== 'commentary');
    const texts = [];
    for (const item of chosen) {
      const text = contentToText(item.content);
      if (text) texts.push(text);
    }
    if (texts.length) return texts.join('\n');
  }
  const parts = reply.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts
      .filter((p) => p && !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  if (typeof reply.content === 'string') return reply.content;
  return '';
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const texts = [];
  for (const item of content) {
    if (typeof item === 'string') {
      texts.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'thinking' || item.type === 'redacted_thinking' || item.type === 'reasoning') {
      continue;
    }
    if (typeof item.text === 'string') texts.push(item.text);
    else if (typeof item.content === 'string' && (item.type === 'output_text' || item.type === 'text')) {
      texts.push(item.content);
    }
  }
  return texts.join('\n');
}

function stripReasoning(text) {
  return String(text || '')
    .replace(/<(thought|thinking|analysis|reasoning)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/?(thought|thinking|analysis|reasoning)>/gi, '')
    .trim();
}

function parseArguments(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isErrorReply(reply) {
  return Boolean(
    reply && typeof reply === 'object' &&
    (reply.error || reply.type === 'error' || reply.stop_reason === 'error')
  );
}

/* ======================= Claude Code side calls ======================= */

function isSideCall(ctx) {
  return isSideCallRequest(ctx?.request, ctx);
}

function isSideCallRequest(body, ctx) {
  const query = String(ctx?.query || '').trim();
  if (/^\[SUGGESTION MODE:/i.test(query)) return true;
  // Claude Code's WebSearch side request is exactly this prompt. Keep the
  // check even when the host does not pass ctx.request: the visible symptom
  // was this side call's search summary arriving as "任务已完成".
  if (/^Perform a web search for the query:/i.test(query)) return true;
  return isSideCallBody(body);
}

/**
 * Claude Code makes internal model requests that are not the user's turn.
 * The WebSearch one carries a distinctive system prompt and only the
 * web_search tool; the suggestion one starts with "[SUGGESTION MODE:".
 */
function isSideCallBody(body) {
  if (!body || typeof body !== 'object') return false;
  const system = systemText(body);
  if (/You are an assistant for performing a web search tool use/i.test(system)) return true;
  if (/\[SUGGESTION MODE:/i.test(system)) return true;

  const lastUser = lastUserText(body);
  if (/^\[SUGGESTION MODE:/i.test(lastUser)) return true;

  if (/^Perform a web search for the query:/i.test(lastUser) && onlyWebSearchTools(body)) {
    return true;
  }
  return false;
}

function onlyWebSearchTools(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (!tools.length) return false;
  return tools.every((tool) => {
    const name = `${tool?.type || ''} ${tool?.name || ''}`.toLowerCase();
    return name.includes('web_search') || name.includes('websearch');
  });
}

function systemText(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  const add = (value) => {
    const text = textOf(value);
    if (text) parts.push(text);
  };
  add(body.system);
  add(body.instructions);
  add(body.systemInstruction);
  add(body.system_instruction);

  const scan = (items) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item && (item.role === 'system' || item.role === 'developer')) add(item.content);
    }
  };
  scan(body.messages);
  scan(body.input);
  return parts.join('\n');
}

function lastUserText(body) {
  if (!body || typeof body !== 'object') return '';

  const scan = (items) => {
    if (!Array.isArray(items)) return '';
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (!item || item.role !== 'user') continue;
      if (Array.isArray(item.content)) {
        const text = item.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join(' ');
        if (text.trim()) return text.trim();
      } else if (typeof item.content === 'string' && item.content.trim()) {
        return item.content.trim();
      }
    }
    return '';
  };

  const fromMessages = scan(body.messages);
  if (fromMessages) return fromMessages;
  const fromInput = scan(body.input);
  if (fromInput) return fromInput;

  // Gemini: contents: [{role: "user", parts: [{text}]}]
  if (Array.isArray(body.contents)) {
    for (let i = body.contents.length - 1; i >= 0; i--) {
      const item = body.contents[i];
      if (!item || item.role !== 'user' || !Array.isArray(item.parts)) continue;
      const text = item.parts
        .filter((p) => p && typeof p.text === 'string')
        .map((p) => p.text)
        .join(' ');
      if (text.trim()) return text.trim();
    }
  }
  return '';
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (Array.isArray(value.content)) return textOf(value.content);
    if (Array.isArray(value.parts)) return textOf(value.parts);
  }
  return '';
}

/* ======================= approval wait ======================= */

function armApprovalWait(calls, ctx, options) {
  const delaySec = numberOption(
    options.approvalWaitSec,
    DEFAULT_APPROVAL_WAIT_SEC,
    0,
    300
  );
  if (delaySec <= 0) return;

  const watched = calls.filter(isApprovalTool);
  if (!watched.length) return;

  const key = pendingKey(ctx);
  cancelApprovalWait(ctx);

  const pending = {
    timer: null,
    callIds: watched.map((call) => call.id).filter(Boolean),
    options: { ...options },
    ctx: {
      query: typeof ctx?.query === 'string' ? ctx.query : '',
      model: typeof ctx?.model === 'string' ? ctx.model : '',
      agent: typeof ctx?.agent === 'string' ? ctx.agent : '',
    },
    calls: watched.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    delaySec,
  };

  pending.timer = setTimeout(() => {
    if (pendingApprovals.get(key) !== pending) return;
    pendingApprovals.delete(key);
    sendApprovalNotice(pending).catch(() => {});
  }, delaySec * 1000);
  pending.timer?.unref?.();
  pendingApprovals.set(key, pending);
}

function isApprovalTool(call) {
  const raw = String(call?.name || '').toLowerCase();
  if (raw.startsWith('mcp__')) return true;
  // Unknown/new client tools are included: a missed prompt is worse than a
  // "possibly waiting" reminder the next request cancels.
  return !AUTO_TOOLS.has(normalizeToolName(raw));
}

function normalizeToolName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cancelApprovalWait(ctx) {
  const key = pendingKey(ctx);
  const pending = pendingApprovals.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingApprovals.delete(key);
}

function pendingKey(ctx) {
  const session = typeof ctx?.session === 'string' ? ctx.session.trim() : '';
  if (session) return `s:${session}`;
  const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd.trim() : '';
  const agent = typeof ctx?.agent === 'string' ? ctx.agent.trim() : '';
  return `c:${agent}|${cwd}`;
}

function turnStartOf(ctx) {
  const key = pendingKey(ctx);
  const start = sessionStarts.get(key);
  const now = Date.now();
  if (Number.isFinite(start) && now - start < TURN_STALE_MS) return start;
  sessionStarts.set(key, now);
  return now;
}

function endTurn(ctx) {
  sessionStarts.delete(pendingKey(ctx));
}

async function sendApprovalNotice(pending) {
  const notifyUrl = stringOption(pending.options.notifyUrl, DEFAULT_NOTIFY_URL);
  if (!/^https?:\/\//i.test(notifyUrl)) return;

  const names = [...new Set(pending.calls.map((call) => call.name))];
  const title = names.some((name) => {
    const n = normalizeToolName(name);
    return n === 'askuserquestion' || n === 'exitplanmode';
  })
    ? '⏸️ Agent 正在等待你的选择'
    : '⏸️ Agent 可能在等待确认';

  const waited = pending.delaySec >= 1
    ? Math.round(pending.delaySec)
    : Math.round(pending.delaySec * 10) / 10;
  const lines = [`⏱️ **已等待**: ${waited} 秒`];
  const query = pending.ctx.query.replace(/\s+/g, ' ').trim();
  if (query) lines.push(`🎯 **任务**: ${truncate(query, 160)}`);
  if (pending.ctx.agent) lines.push(`🤖 **Agent**: ${pending.ctx.agent}`);
  lines.push(`🛠️ **工具**: ${truncate(names.join(', '), 200)}`);

  const detail = describeCalls(pending.calls);
  if (detail) lines.push('', `📝 **操作**:`, detail);
  lines.push(
    '',
    '> 如果客户端正停在“允许/拒绝”或选项选择上，请回到 Magpie/终端处理；企微端目前只能收到提醒。'
  );

  // The host's per-request hook budget no longer applies: this runs from a
  // timer after onResponse returned. Give the local service a sane bound.
  const timeoutMs = Math.max(
    2000,
    numberOption(pending.options.gatewayTimeoutMs, FETCH_TIMEOUT_MS, 100, 10_000)
  );
  await postJson(notifyUrl, { title, content: lines.join('\n') }, undefined, timeoutMs);
}

function describeCalls(calls) {
  const parts = [];
  for (const call of calls.slice(0, 3)) {
    const detail = describeInput(call.name, call.input);
    parts.push(detail ? `**${call.name}**: ${detail}` : `**${call.name}**`);
  }
  if (calls.length > 3) parts.push(`… 另有 ${calls.length - 3} 个工具调用`);
  return truncate(parts.join('\n'), 700);
}

function describeInput(name, input) {
  if (input == null) return '';
  if (typeof input === 'string') return truncate(input, 400);
  if (typeof input !== 'object') return truncate(String(input), 200);

  switch (normalizeToolName(name)) {
    case 'bash':
      return truncate(input.command || '', 400);
    case 'read':
    case 'write':
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
      return truncate(input.file_path || input.notebook_path || '', 240);
    case 'webfetch':
      return truncate(input.url || '', 240);
    case 'task':
      return truncate(input.description || input.prompt || '', 240);
    case 'askuserquestion': {
      const questions = Array.isArray(input.questions) ? input.questions : [];
      return truncate(
        questions.map((q) => {
          const options = Array.isArray(q?.options)
            ? q.options.map((o) => o?.label).filter(Boolean).join(' / ')
            : '';
          return [q?.question, options ? `[${options}]` : ''].filter(Boolean).join(' ');
        }).join('\n'),
        600
      );
    }
    case 'exitplanmode':
      return truncate(input.plan || '', 500);
    default:
      try {
        return truncate(JSON.stringify(input), 400);
      } catch {
        return '';
      }
  }
}

/* ======================= small utilities ======================= */

function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function truncateBytes(text, maxBytes) {
  const s = String(text || '');
  if (!s) return s;

  try {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(s);
    if (bytes.length <= maxBytes) return s;

    const marker = '\n…（内容过长，已截断）…';
    const markerBytes = encoder.encode(marker).length;
    let end = Math.max(0, maxBytes - markerBytes);
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return new TextDecoder().decode(bytes.subarray(0, end)) + marker;
  } catch {
    // TextEncoder unavailable: fall back to a conservative character cap.
    return truncate(s, Math.floor(maxBytes / 3));
  }
}

function stringOption(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberOption(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function postJson(url, payload, signal, timeoutMs = FETCH_TIMEOUT_MS) {
  if (typeof fetch !== 'function') return false;

  let timeout = null;
  try {
    timeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : null;
  } catch {
    timeout = null;
  }

  let combined = timeout;
  try {
    if (signal && timeout && typeof AbortSignal.any === 'function') {
      combined = AbortSignal.any([signal, timeout]);
    } else if (signal) {
      combined = signal;
    }
  } catch {
    combined = timeout;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: combined || undefined,
    });
    return res.ok;
  } catch {
    return false;
  }
}
