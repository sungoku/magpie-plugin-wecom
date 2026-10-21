import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export interface AgentConfig {
  type: 'cli' | 'http';
  command?: string;
  url?: string;
  description?: string;
}

export interface BotConfig {
  id: string; // 内部唯一标识，如 "bot-1"
  name: string; // 角色名称，如 "架构重构助手"
  botId: string; // 企微后台生成的 Bot ID
  secret: string; // 企微后台生成的 Secret
  defaultAgent: string; // 绑定的默认 Agent (如 "claude", "opencode", "sh")
  allowedUsers?: string[]; // 允许发指令的用户白名单
  promptPrefix?: string; // 可选的角色人设提示词前缀
}

export interface BridgeConfig {
  server?: {
    port: number; // 本地 HTTP 管理与通知端口，默认 9099
    host?: string;
  };
  defaultAgent: string;
  agents: Record<string, AgentConfig>;
  // 多 Bot 列表支持
  bots: BotConfig[];
  // 保持单 bot 兼容字段
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

export const defaultConfig: BridgeConfig = {
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

export function getConfigFilePath(customConfigPath?: string): string {
  const possiblePaths = [
    customConfigPath,
    path.resolve(process.cwd(), 'config.json'),
    path.resolve(process.cwd(), 'config.local.json'),
    path.resolve(process.cwd(), '../../config.json'),
  ].filter(Boolean) as string[];

  for (const filePath of possiblePaths) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  // 默认返回当前目录下的 config.json
  return path.resolve(process.cwd(), 'config.json');
}

export function loadConfig(customConfigPath?: string): BridgeConfig {
  const configPath = getConfigFilePath(customConfigPath);

  if (fs.existsSync(configPath)) {
    try {
      const fileContent = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(fileContent);
      const merged: BridgeConfig = {
        ...defaultConfig,
        ...parsed,
        server: { ...defaultConfig.server, ...parsed.server },
        agents: { ...defaultConfig.agents, ...(parsed.agents || {}) },
        bots: Array.isArray(parsed.bots) ? parsed.bots : [],
        autoSniff: { ...defaultConfig.autoSniff, ...(parsed.autoSniff || {}) },
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
    } catch (e) {
      console.warn(`[Config] 解析配置文件 ${configPath} 失败，使用默认配置:`, e);
    }
  }

  // 尝试环境变量兜底
  if (process.env.WECOM_BOT_ID && process.env.WECOM_SECRET) {
    return {
      ...defaultConfig,
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

  return defaultConfig;
}

export function saveConfig(newConfig: Partial<BridgeConfig>, customConfigPath?: string): void {
  const configPath = getConfigFilePath(customConfigPath);
  const current = loadConfig(customConfigPath);
  const merged = {
    ...current,
    ...newConfig,
  };

  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`[Config] 配置已成功保存至: ${configPath}`);
}
