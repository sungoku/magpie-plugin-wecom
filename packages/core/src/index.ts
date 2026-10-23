import path from 'node:path';
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
export * from './util.js';

export const VERSION = '1.1.1';

export interface StartOptions {
  configPath?: string;
  /** Run the local HTTP server on another port (CLI flag). */
  port?: number;
}

export function startBridge(customConfig?: Partial<BridgeConfig>, options: StartOptions | string = {}) {
  const opts: StartOptions = typeof options === 'string' ? { configPath: options } : options;

  const config = loadConfig(opts.configPath);
  const server = {
    port: opts.port ?? customConfig?.server?.port ?? config.server?.port ?? 9099,
    host: customConfig?.server?.host ?? config.server?.host ?? '127.0.0.1',
  };
  const merged: BridgeConfig = {
    ...config,
    ...customConfig,
    server,
    agents: { ...config.agents, ...(customConfig?.agents || {}) },
    bots: customConfig?.bots ?? config.bots,
  };

  console.log('====================================================');
  console.log(`🚀 WeCom Agent Bridge (企业微信多 Bot 智能网关) v${VERSION} 启动`);
  console.log('====================================================');

  // 1. 初始化 Router 并注册已配置的 CLI Agent 适配器
  const router = new AgentRouter(merged.defaultAgent);

  for (const [name, agentCfg] of Object.entries(merged.agents)) {
    if (agentCfg.type === 'cli' && agentCfg.command) {
      router.register(
        new CliAdapter(name, agentCfg.command, agentCfg.description, agentCfg.timeoutSec)
      );
    }
  }

  // 2. 初始化企微多 Bot 管理器
  const wecomManager = new WeComManager(router);
  wecomManager.reloadBots(merged.bots);

  if (merged.bots.length === 0) {
    console.warn('⚠️ 暂未配置任何企微 Bot，可通过管理界面或 config.json 添加。');
  } else {
    wecomManager.startAll();
  }

  // 3. 启动本地管理与通知 HTTP 接口
  const notifyServer = new NotifyServer({
    port: server.port,
    host: server.host,
    wecomManager,
    configPath: opts.configPath,
  });

  notifyServer.start();

  return {
    router,
    wecomManager,
    notifyServer,
    config: merged,
  };
}

// Direct run: `tsx src/index.ts` or `node dist/index.js`
const entry = process.argv[1] ? path.basename(process.argv[1]) : '';
if (entry === 'index.ts' || entry === 'index.js') {
  const bridge = startBridge();
  const shutdown = () => {
    console.log('\n👋 正在关闭...');
    bridge.wecomManager.stopAll();
    bridge.notifyServer.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
