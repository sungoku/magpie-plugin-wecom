import http from 'node:http';

/**
 * 轻量标准 MCP (Model Context Protocol) 服务端实现 (基于 stdio)
 * 让 Claude Code / Antigravity / Cursor 可以直接作为 MCP Tool 挂载使用：
 * 工具名: `wecom_send_notification`
 *
 * 运行: `wecom-bridge mcp --port 9099`
 */
export function startMcpServer(notifyPort = 9099) {
  process.stdin.setEncoding('utf-8');

  let buffer = '';

  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line);
        await handleMcpRequest(req, notifyPort);
      } catch {
        // 忽略非 JSON 行
      }
    }
  });

  console.error(`[MCP] wecom-agent-bridge MCP Server 已启动 (转发到 127.0.0.1:${notifyPort})`);
}

async function handleMcpRequest(req: any, notifyPort: number) {
  const { id, method, params } = req;

  // 1. 初始化能力协商
  if (method === 'initialize') {
    sendJson({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'wecom-agent-bridge-mcp',
          version: '1.1.1',
        },
      },
    });
    return;
  }

  // 初始化完成通知：JSON-RPC notification，无需响应
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return;
  }

  // MCP keepalive
  if (method === 'ping') {
    sendJson({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  // 2. 列出提供的工具
  if (method === 'tools/list') {
    sendJson({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'wecom_send_notification',
            description: '发送即时消息通知到用户的手机企业微信 (WeCom)',
            inputSchema: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description: '要推送到手机上的具体通知内容或任务总结 (支持 Markdown)',
                },
                title: {
                  type: 'string',
                  description: '通知卡片标题 (可选)',
                },
              },
              required: ['content'],
            },
          },
        ],
      },
    });
    return;
  }

  // 3. 执行工具调用
  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    if (name !== 'wecom_send_notification') {
      sendJson({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `未知工具: ${name}` },
      });
      return;
    }

    const content = String(args?.content || '');
    const title = args?.title ? String(args.title) : undefined;
    if (!content.trim()) {
      sendJson({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: '⚠️ content 不能为空。' }],
        },
      });
      return;
    }

    const ok = await forwardToLocalNotify(content, title, notifyPort);
    sendJson({
      jsonrpc: '2.0',
      id,
      result: {
        isError: !ok,
        content: [
          {
            type: 'text',
            text: ok
              ? '✅ 消息已成功推送到用户的手机企业微信！'
              : '⚠️ 推送失败，请确认 wecom-agent-bridge 网关服务是否在本地运行。',
          },
        ],
      },
    });
    return;
  }

  // 4. 未知方法
  if (id !== undefined) {
    sendJson({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `未知方法: ${method}` },
    });
  }
}

function sendJson(obj: any) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function forwardToLocalNotify(content: string, title?: string, port = 9099): Promise<boolean> {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ content, title });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/notify',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        finish(res.statusCode === 200);
      }
    );

    // A gateway that accepts the socket but never answers must not hang the
    // MCP client's tool call forever.
    timer = setTimeout(() => {
      req.destroy();
      finish(false);
    }, 5000);
    timer.unref?.();

    req.on('error', () => finish(false));
    req.write(payload);
    req.end();
  });
}
