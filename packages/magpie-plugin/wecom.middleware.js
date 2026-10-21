/**
 * @magpie-community/middleware-wecom
 * 
 * Magpie 官方网关中间件：
 * 负责在网络层自动嗅探所有走 Magpie 代理的 Coding Agent（Claude Code / OpenCode / Codex 等）。
 * 当检测到一轮长任务彻底执行完毕时，自动向企业微信推送富文本总结卡片。
 * 
 * 规范：单文件，无外部 npm 依赖，基于全局原生 fetch。
 */

export function onRequest(ctx, request) {
  // 记录请求开始时间与模型信息
  ctx.startTime = Date.now();
  ctx.model = request?.model || 'unknown-model';
  ctx.hasToolCalls = false;
  ctx.accumulatedText = '';

  // 提取用户最末一条 prompt 摘要
  const messages = request?.messages || [];
  const lastUserMsg = messages.slice().reverse().find((m) => m.role === 'user');
  if (lastUserMsg) {
    const rawContent = typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content
      : JSON.stringify(lastUserMsg.content);
    ctx.userPromptPreview = rawContent.slice(0, 80) + (rawContent.length > 80 ? '...' : '');
  } else {
    ctx.userPromptPreview = '未知任务';
  }

  return request;
}

export function onEvent(ctx, event) {
  // 监听流式 Event，检测是否有 tool_calls 触发或内容输出
  if (!event) return event;

  try {
    const delta = event.choices?.[0]?.delta;
    if (delta) {
      if (delta.content) {
        ctx.accumulatedText += delta.content;
      }
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        ctx.hasToolCalls = true;
      }
    }

    // 检测流式完成信号 (OpenAI/Anthropic 标准)
    const finishReason = event.choices?.[0]?.finish_reason || event.type;
    if (finishReason === 'stop' || finishReason === 'message_stop') {
      triggerNotificationIfEligible(ctx, '流式任务');
    }
  } catch (e) {
    // 忽略解析偶发错误，保障网关健壮性
  }

  return event;
}

export function onResponse(ctx, response) {
  // 非流式响应检测
  if (!response) return response;

  try {
    const choice = response.choices?.[0];
    const text = choice?.message?.content || '';
    if (text) {
      ctx.accumulatedText = text;
    }
    const finishReason = choice?.finish_reason;
    if (finishReason === 'stop') {
      triggerNotificationIfEligible(ctx, '完整任务');
    }
  } catch (e) {
    // ignore
  }

  return response;
}

/**
 * 满足阈值条件时，异步触发企微通知
 */
function triggerNotificationIfEligible(ctx, taskType) {
  const options = ctx.options || {};
  if (options.enabled === false) return;

  const durationSec = Math.round((Date.now() - (ctx.startTime || Date.now())) / 1000);
  const minDuration = options.minDurationSec ?? 3;

  // 过滤掉小于设定秒数的极短请求（例如心跳、短代码补全提示）
  if (durationSec < minDuration) {
    return;
  }

  const notifyUrl = options.notifyUrl || 'http://127.0.0.1:9099/notify';
  const preview = ctx.accumulatedText 
    ? (ctx.accumulatedText.slice(0, 150) + (ctx.accumulatedText.length > 150 ? '...' : ''))
    : '无文本回显';

  const cardTitle = `🎉 Agent 任务已完成 (${ctx.model})`;
  const cardContent = `
⏱️ **耗时**: ${durationSec} 秒
🎯 **任务**: ${ctx.userPromptPreview || '代码生成任务'}
📝 **结果摘要**:
> ${preview.replace(/\n/g, '\n> ')}

💡 *通过 Magpie 网关自动推送*
`.trim();

  // 异步发起通知，绝对不阻塞网关核心流量
  try {
    fetch(notifyUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: cardTitle,
        content: cardContent,
      }),
    }).catch(() => {
      // 本地通知接口若未启动，静默捕获
    });
  } catch (err) {
    // ignore
  }
}
