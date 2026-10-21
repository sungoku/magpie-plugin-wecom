import type { AgentRouter } from '../router/router.js';
import type { BotConfig } from '../config.js';
export interface BotInstanceStatus {
    id: string;
    name: string;
    botId: string;
    defaultAgent: string;
    status: 'connected' | 'connecting' | 'disconnected' | 'error';
    lastError?: string;
    connectedAt?: string;
}
export declare class BotInstance {
    config: BotConfig;
    private client;
    private router;
    status: 'connected' | 'connecting' | 'disconnected' | 'error';
    lastError?: string;
    connectedAt?: string;
    lastActiveFrame: any;
    constructor(config: BotConfig, router: AgentRouter);
    connect(): void;
    disconnect(): void;
    private isAllowed;
    private handleMessage;
    notify(content: string, title?: string): Promise<boolean>;
    getStatus(): BotInstanceStatus;
}
/**
 * 管理多个企业微信 Bot 实例的管理器
 */
export declare class WeComManager {
    private bots;
    private router;
    isRunning: boolean;
    constructor(router: AgentRouter);
    reloadBots(botConfigs: BotConfig[]): void;
    startAll(): void;
    stopAll(): void;
    notifyAll(content: string, title?: string): Promise<{
        sent: number;
        total: number;
    }>;
    getStatusList(): BotInstanceStatus[];
}
//# sourceMappingURL=client.d.ts.map