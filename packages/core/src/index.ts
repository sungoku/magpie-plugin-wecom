import { loadConfig, type BridgeConfig } from './config.js';
import { AgentRouter } from './router/router.js';
import { CliAdapter } from './adapters/cli-adapter.js';
import { WeComManager } from './wecom/client.js';
import { NotifyServer } from './server/notify-server.js';

export * from './config.js';
export * from './adapters/types.js';
export * from './adapters/cli-adapter.js';
export * from './router/router.js';
export * from './wecom/client.js';
export * from './server/notify-server.js';

export function startBridge(customConfig?: Partial<BridgeConfig>) {
  const config = {
    ...loadConfig(),
    ...customConfig,
  };

  console.log('====================================================');
  console.log('🚀 WeCom Agent Bridge (企业微信多 Bot 智能网关) 启动');
  console.log('====================================================');

  // 1. 初始化 Router 并注册已配置的 CLI Agent 适配器
  const router = new AgentRouter(config.defaultAgent);

  for (const [name, agentCfg] of Object.entries(config.agents)) {
    if (agentCfg.type === 'cli' && agentCfg.command) {
      router.register(new CliAdapter(name, agentCfg.command, agentCfg.description));
    }
  }

  // 2. 初始化企微多 Bot 管理器
  const wecomManager = new WeComManager(router);
  wecomManager.reloadBots(config.bots);

  if (config.bots.length === 0) {
    console.warn('⚠️ 暂未配置任何企微 Bot，可通过 Web 界面或 config.json 添加。');
  } else {
    wecomManager.startAll();
  }

  // 3. 启动本地管理与通知 HTTP 接口
  const notifyServer = new NotifyServer({
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
