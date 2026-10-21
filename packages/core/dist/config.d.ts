export interface AgentConfig {
    type: 'cli' | 'http';
    command?: string;
    url?: string;
    description?: string;
}
export interface BotConfig {
    id: string;
    name: string;
    botId: string;
    secret: string;
    defaultAgent: string;
    allowedUsers?: string[];
    promptPrefix?: string;
}
export interface BridgeConfig {
    server?: {
        port: number;
        host?: string;
    };
    defaultAgent: string;
    agents: Record<string, AgentConfig>;
    bots: BotConfig[];
    wecom?: {
        botId?: string;
        secret?: string;
        allowedUsers?: string[];
    };
    autoSniff?: {
        enabled: boolean;
        minDurationSec: number;
    };
}
export declare const defaultConfig: BridgeConfig;
export declare function getConfigFilePath(customConfigPath?: string): string;
export declare function loadConfig(customConfigPath?: string): BridgeConfig;
export declare function saveConfig(newConfig: Partial<BridgeConfig>, customConfigPath?: string): void;
//# sourceMappingURL=config.d.ts.map