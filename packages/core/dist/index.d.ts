import { type BridgeConfig } from './config.js';
import { AgentRouter } from './router/router.js';
import { WeComManager } from './wecom/client.js';
import { NotifyServer } from './server/notify-server.js';
export * from './config.js';
export * from './adapters/types.js';
export * from './adapters/cli-adapter.js';
export * from './router/router.js';
export * from './wecom/client.js';
export * from './server/notify-server.js';
export declare function startBridge(customConfig?: Partial<BridgeConfig>): {
    router: AgentRouter;
    wecomManager: WeComManager;
    notifyServer: NotifyServer;
};
//# sourceMappingURL=index.d.ts.map