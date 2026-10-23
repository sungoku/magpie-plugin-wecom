import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  asStringArray,
  asTrimmedString,
  looksMasked,
  maskSecret,
} from './util.js';

dotenv.config();

export interface AgentConfig {
  type: 'cli' | 'http';
  command?: string;
  url?: string;
  description?: string;
  /** 单次任务最长执行时间（秒），默认 900。 */
  timeoutSec?: number;
}

export interface BotConfig {
  id: string; // 内部唯一标识，如 "bot-1"
  name: string; // 角色名称，如 "架构重构助手"
  botId: string; // 企微后台生成的 Bot ID
  secret: string; // 企微后台生成的 Secret
  defaultAgent: string; // 绑定的默认 Agent (如 "claude", "opencode", "sh")
  allowedUsers?: string[]; // 允许发指令的用户白名单；空数组 = 不限制
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
}

export const MAX_BOTS = 20;
const MAX_BOT_ID = 256;
const MAX_BOT_NAME = 80;
const MAX_PROMPT_PREFIX = 8000;
const MAX_ALLOWED_USERS = 100;
const MAX_USER_ID = 200;

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
      timeoutSec: 900,
    },
    opencode: {
      type: 'cli',
      command: 'opencode run "{prompt}"',
      description: 'OpenCode 编程 Agent',
      timeoutSec: 900,
    },
    sh: {
      type: 'cli',
      command: '{prompt}',
      description: '原生终端命令直接执行',
      timeoutSec: 300,
    },
  },
  bots: [],
};

export function getConfigFilePath(customConfigPath?: string): string {
  const possiblePaths = [
    customConfigPath,
    process.env.WECOM_BRIDGE_CONFIG,
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

  // Once the bot list is written, it is the source of truth. Keeping the
  // legacy single-bot `wecom` block would resurrect a deleted bot on the
  // next load.
  if (Array.isArray(newConfig.bots)) {
    delete merged.wecom;
  }

  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  try {
    // The file holds bot secrets; keep it owner-only.
    fs.chmodSync(configPath, 0o600);
  } catch {
    // chmod is best effort (e.g. Windows)
  }
  console.log(`[Config] 配置已成功保存至: ${configPath}`);
}

/**
 * Sanitize bots coming from the management UI. A secret is only replaced when
 * the caller sends a real, non-masked value; otherwise the secret already on
 * disk for the same bot id is kept.
 */
export function sanitizeBots(input: unknown, currentBots: BotConfig[], agents: Record<string, AgentConfig>): BotConfig[] {
  if (!Array.isArray(input)) {
    throw new Error('bots 必须是数组');
  }
  const out: BotConfig[] = [];
  const seenIds = new Set<string>();
  const agentNames = Object.keys(agents);

  for (const raw of input.slice(0, MAX_BOTS)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;

    const rawId = asTrimmedString(item.id, 64);
    let id = rawId || `bot-${Date.now()}-${out.length + 1}`;
    for (let n = 2; seenIds.has(id); n++) {
      id = `${rawId || `bot-${Date.now()}-${out.length + 1}`}-${n}`;
    }
    seenIds.add(id);

    // Only an existing id may inherit the secret already on disk; a new bot
    // never picks up another bot's credentials.
    const previous = rawId ? currentBots.find((b) => b.id === id) : undefined;

    const incomingSecret = typeof item.secret === 'string' ? item.secret.trim() : '';
    const secret = incomingSecret && !looksMasked(incomingSecret)
      ? incomingSecret.slice(0, 512)
      : (previous?.secret || '');

    const requestedAgent = asTrimmedString(item.defaultAgent, 64);
    const defaultAgent = agentNames.includes(requestedAgent)
      ? requestedAgent
      : (agentNames.includes(previous?.defaultAgent || '') ? previous!.defaultAgent : (agentNames[0] || 'claude'));

    // A missing field keeps what is on disk; an explicit empty value clears it.
    const name = typeof item.name === 'string'
      ? asTrimmedString(item.name, MAX_BOT_NAME)
      : (previous?.name || '');
    const botId = typeof item.botId === 'string'
      ? asTrimmedString(item.botId, MAX_BOT_ID)
      : (previous?.botId || '');
    const allowedUsers = Array.isArray(item.allowedUsers)
      ? asStringArray(item.allowedUsers, MAX_ALLOWED_USERS, MAX_USER_ID)
      : (previous?.allowedUsers || []);
    const promptPrefix = typeof item.promptPrefix === 'string'
      ? asTrimmedString(item.promptPrefix, MAX_PROMPT_PREFIX)
      : (previous?.promptPrefix || '');

    out.push({
      id,
      name: name || `Bot ${out.length + 1}`,
      botId,
      secret,
      defaultAgent,
      allowedUsers,
      promptPrefix,
    });
  }

  return out;
}

/** What the management UI may see: never secrets, never legacy wecom credentials. */
export function publicConfig(config: BridgeConfig) {
  return {
    defaultAgent: config.defaultAgent,
    agents: Object.fromEntries(
      Object.entries(config.agents || {}).map(([name, a]) => [
        name,
        { type: a.type, description: a.description || '' },
      ])
    ),
    server: config.server,
    bots: (config.bots || []).map((b) => ({
      id: b.id,
      name: b.name,
      botId: b.botId,
      defaultAgent: b.defaultAgent,
      allowedUsers: b.allowedUsers || [],
      promptPrefix: b.promptPrefix || '',
      secretSet: Boolean(b.secret),
      secretMasked: maskSecret(b.secret),
    })),
  };
}
