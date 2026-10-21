"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startBridge = startBridge;
const config_js_1 = require("./config.js");
const router_js_1 = require("./router/router.js");
const cli_adapter_js_1 = require("./adapters/cli-adapter.js");
const client_js_1 = require("./wecom/client.js");
const notify_server_js_1 = require("./server/notify-server.js");
__exportStar(require("./config.js"), exports);
__exportStar(require("./adapters/types.js"), exports);
__exportStar(require("./adapters/cli-adapter.js"), exports);
__exportStar(require("./router/router.js"), exports);
__exportStar(require("./wecom/client.js"), exports);
__exportStar(require("./server/notify-server.js"), exports);
function startBridge(customConfig) {
    const config = {
        ...(0, config_js_1.loadConfig)(),
        ...customConfig,
    };
    console.log('====================================================');
    console.log('🚀 WeCom Agent Bridge (企业微信多 Bot 智能网关) 启动');
    console.log('====================================================');
    // 1. 初始化 Router 并注册已配置的 CLI Agent 适配器
    const router = new router_js_1.AgentRouter(config.defaultAgent);
    for (const [name, agentCfg] of Object.entries(config.agents)) {
        if (agentCfg.type === 'cli' && agentCfg.command) {
            router.register(new cli_adapter_js_1.CliAdapter(name, agentCfg.command, agentCfg.description));
        }
    }
    // 2. 初始化企微多 Bot 管理器
    const wecomManager = new client_js_1.WeComManager(router);
    wecomManager.reloadBots(config.bots);
    if (config.bots.length === 0) {
        console.warn('⚠️ 暂未配置任何企微 Bot，可通过 Web 界面或 config.json 添加。');
    }
    else {
        wecomManager.startAll();
    }
    // 3. 启动本地管理与通知 HTTP 接口
    const notifyServer = new notify_server_js_1.NotifyServer({
        port: config.server?.port || 9099,
        host: config.server?.host || '127.0.0.1',
        wecomManager,
    });
    notifyServer.start();
    return {
        router,
        wecomManager,
        notifyServer,
    };
}
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
    startBridge();
}
//# sourceMappingURL=index.js.map