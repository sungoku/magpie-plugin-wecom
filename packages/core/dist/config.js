"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultConfig = void 0;
exports.getConfigFilePath = getConfigFilePath;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
exports.defaultConfig = {
    server: {
        port: Number(process.env.NOTIFY_PORT) || 9099,
        host: '127.0.0.1',
    },
    defaultAgent: 'claude',
    agents: {
        claude: {
            type: 'cli',
            command: 'claude -p "{prompt}"',
            description: 'Claude Code 编程 Agent',
        },
        opencode: {
            type: 'cli',
            command: 'opencode run "{prompt}"',
            description: 'OpenCode 编程 Agent',
        },
        sh: {
            type: 'cli',
            command: '{prompt}',
            description: '原生终端命令直接执行',
        },
    },
    bots: [],
    autoSniff: {
        enabled: true,
        minDurationSec: 3,
    },
};
function getConfigFilePath(customConfigPath) {
    const possiblePaths = [
        customConfigPath,
        node_path_1.default.resolve(process.cwd(), 'config.json'),
        node_path_1.default.resolve(process.cwd(), 'config.local.json'),
        node_path_1.default.resolve(process.cwd(), '../../config.json'),
    ].filter(Boolean);
    for (const filePath of possiblePaths) {
        if (node_fs_1.default.existsSync(filePath)) {
            return filePath;
        }
    }
    // 默认返回当前目录下的 config.json
    return node_path_1.default.resolve(process.cwd(), 'config.json');
}
function loadConfig(customConfigPath) {
    const configPath = getConfigFilePath(customConfigPath);
    if (node_fs_1.default.existsSync(configPath)) {
        try {
            const fileContent = node_fs_1.default.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(fileContent);
            const merged = {
                ...exports.defaultConfig,
                ...parsed,
                server: { ...exports.defaultConfig.server, ...parsed.server },
                agents: { ...exports.defaultConfig.agents, ...(parsed.agents || {}) },
                bots: Array.isArray(parsed.bots) ? parsed.bots : [],
                autoSniff: { ...exports.defaultConfig.autoSniff, ...(parsed.autoSniff || {}) },
            };
            // 兼容老版本单 bot 配置
            if (merged.bots.length === 0 && parsed.wecom?.botId && parsed.wecom?.secret) {
                merged.bots.push({
                    id: 'default-bot',
                    name: '默认助手',
                    botId: parsed.wecom.botId,
                    secret: parsed.wecom.secret,
                    defaultAgent: parsed.defaultAgent || 'claude',
                    allowedUsers: parsed.wecom.allowedUsers || [],
                });
            }
            return merged;
        }
        catch (e) {
            console.warn(`[Config] 解析配置文件 ${configPath} 失败，使用默认配置:`, e);
        }
    }
    // 尝试环境变量兜底
    if (process.env.WECOM_BOT_ID && process.env.WECOM_SECRET) {
        return {
            ...exports.defaultConfig,
            bots: [
                {
                    id: 'env-bot',
                    name: '默认助手 (Env)',
                    botId: process.env.WECOM_BOT_ID,
                    secret: process.env.WECOM_SECRET,
                    defaultAgent: 'claude',
                    allowedUsers: process.env.WECOM_ALLOWED_USERS
                        ? process.env.WECOM_ALLOWED_USERS.split(',').map((u) => u.trim())
                        : [],
                },
            ],
        };
    }
    return exports.defaultConfig;
}
function saveConfig(newConfig, customConfigPath) {
    const configPath = getConfigFilePath(customConfigPath);
    const current = loadConfig(customConfigPath);
    const merged = {
        ...current,
        ...newConfig,
    };
    node_fs_1.default.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
    console.log(`[Config] 配置已成功保存至: ${configPath}`);
}
//# sourceMappingURL=config.js.map