"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startMcpServer = startMcpServer;
const node_http_1 = __importDefault(require("node:http"));
/**
 * 轻量标准 MCP (Model Context Protocol) 服务端实现 (基于 stdio)
 * 让 Claude Code / Antigravity / Cursor 可以直接作为 MCP Tool 挂载使用：
 * 工具名: `wecom_send_notification`
 */
function startMcpServer(notifyPort = 9099) {
    process.stdin.setEncoding('utf-8');
    let buffer = '';
    process.stdin.on('data', async (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim())
                continue;
            try {
                const req = JSON.parse(line);
                await handleMcpRequest(req, notifyPort);
            }
            catch (e) {
                // 忽略非 JSON 行
            }
        }
    });
}
async function handleMcpRequest(req, notifyPort) {
    const { id, method, params } = req;
    // 1. 初始化能力协商
    if (method === 'initialize') {
        const res = {
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {},
                },
                serverInfo: {
                    name: 'wecom-agent-bridge-mcp',
                    version: '1.0.0',
                },
            },
        };
        sendJson(res);
        return;
    }
    // 2. 列出提供的工具
    if (method === 'tools/list') {
        const res = {
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
        };
        sendJson(res);
        return;
    }
    // 3. 执行工具调用
    if (method === 'tools/call') {
        const { name, arguments: args } = params || {};
        if (name === 'wecom_send_notification') {
            const content = args?.content || '';
            const title = args?.title;
            const ok = await forwardToLocalNotify(content, title, notifyPort);
            sendJson({
                jsonrpc: '2.0',
                id,
                result: {
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
    }
    // 默认空响应或不支持的方法
    if (id !== undefined) {
        sendJson({
            jsonrpc: '2.0',
            id,
            result: {},
        });
    }
}
function sendJson(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}
function forwardToLocalNotify(content, title, port = 9099) {
    return new Promise((resolve) => {
        const payload = JSON.stringify({ content, title });
        const req = node_http_1.default.request({
            hostname: '127.0.0.1',
            port,
            path: '/notify',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
            },
        }, (res) => {
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.write(payload);
        req.end();
    });
}
//# sourceMappingURL=server.js.map