import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
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

export class BotInstance {
  config: BotConfig;
  private client: any;
  private router: AgentRouter;
  status: 'connected' | 'connecting' | 'disconnected' | 'error' = 'disconnected';
  lastError?: string;
  connectedAt?: string;
  lastActiveFrame: any = null;

  constructor(config: BotConfig, router: AgentRouter) {
    this.config = config;
    this.router = router;
  }

  connect(): void {
    if (!this.config.botId || !this.config.secret) {
      this.status = 'error';
      this.lastError = '缺少 Bot ID 或 Secret';
      return;
    }

    this.status = 'connecting';
    console.log(`[Bot:${this.config.name}] 正在建立长连接 (BotID: ${this.config.botId})...`);

    this.client = new WSClient({
      botId: this.config.botId,
      secret: this.config.secret,
    });

    this.client.on('authenticated', () => {
      this.status = 'connected';
      this.connectedAt = new Date().toISOString();
      this.lastError = undefined;
      console.log(`🎉 [Bot:${this.config.name}] 认证成功并在线！(绑定 Agent: ${this.config.defaultAgent})`);
    });

    this.client.on('error', (err: any) => {
      this.status = 'error';
      this.lastError = err?.message || String(err);
      console.error(`❌ [Bot:${this.config.name}] 连接错误:`, this.lastError);
    });

    this.client.on('disconnect', () => {
      this.status = 'disconnected';
      console.warn(`⚠️ [Bot:${this.config.name}] 连接已断开，SDK 自动重连中...`);
    });

    this.client.on('message.text', async (frame: any) => {
      await this.handleMessage(frame);
    });

    this.client.connect();
  }

  disconnect(): void {
    if (this.client) {
      try {
        // SDK 如果提供了 close/disconnect 方法
        if (typeof this.client.disconnect === 'function') {
          this.client.disconnect();
        } else if (typeof this.client.close === 'function') {
          this.client.close();
        }
      } catch (e) {
        // ignore
      }
      this.status = 'disconnected';
      console.log(`🛑 [Bot:${this.config.name}] 已断开连接。`);
    }
  }

  private isAllowed(fromUser: string): boolean {
    const list = this.config.allowedUsers || [];
    if (list.length === 0) return true;
    return list.includes(fromUser);
  }

  private async handleMessage(frame: any): Promise<void> {
    const rawContent = frame.body?.text?.content || '';
    const fromUser = frame.body?.from || 'unknown';
    this.lastActiveFrame = frame;

    console.log(`\n📨 [${this.config.name}] 收到用户 [${fromUser}] 指令: "${rawContent}"`);

    if (!this.isAllowed(fromUser)) {
      console.warn(`⛔ [${this.config.name}] 用户 [${fromUser}] 不在白名单中，拒绝响应。`);
      const streamId = generateReqId('stream');
      await this.client.replyStream(
        frame,
        streamId,
        `⛔ [${this.config.name}]：抱歉，你的账号 (${fromUser}) 未在授权白名单中。`,
        true
      );
      return;
    }

    const streamId = generateReqId('stream');
    try {
      await this.client.replyStream(
        frame,
        streamId,
        `⏳ **[${this.config.name}] 已接收指令**\n> ${rawContent}\n\n正在调用 Agent (\`${this.config.defaultAgent}\`) 处理...`,
        false
      );

      // 如果配置了提示词前缀 (如角色人设)
      const promptToExecute = this.config.promptPrefix
        ? `${this.config.promptPrefix}\n\n${rawContent}`
        : rawContent;

      const finalResult = await this.router.dispatch(
        promptToExecute,
        fromUser,
        async (_chunk, fullOutput) => {
          const preview = fullOutput.length > 1500
            ? fullOutput.slice(fullOutput.length - 1500)
            : fullOutput;
          await this.client.replyStream(
            frame,
            streamId,
            `⚙️ **[${this.config.name}] 执行中...**\n\`\`\`text\n${preview}\n\`\`\``,
            false
          );
        },
        this.config.defaultAgent
      );

      await this.client.replyStream(frame, streamId, finalResult, true);
      console.log(`✅ [${this.config.name}] 结果已推回企微。`);
    } catch (err: any) {
      console.error(`❌ [${this.config.name}] 任务失败:`, err);
      try {
        await this.client.replyStream(
          frame,
          streamId,
          `❌ 执行出错: ${err?.message || err}`,
          true
        );
      } catch (e) {
        // ignore
      }
    }
  }

  async notify(content: string, title?: string): Promise<boolean> {
    if (!this.lastActiveFrame || this.status !== 'connected') {
      return false;
    }

    const streamId = generateReqId('notify');
    const message = title ? `🔔 **${title}**\n\n${content}` : `🔔 ${content}`;

    try {
      await this.client.replyStream(this.lastActiveFrame, streamId, message, true);
      return true;
    } catch (e) {
      return false;
    }
  }

  getStatus(): BotInstanceStatus {
    return {
      id: this.config.id,
      name: this.config.name,
      botId: this.config.botId,
      defaultAgent: this.config.defaultAgent,
      status: this.status,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
    };
  }
}

/**
 * 管理多个企业微信 Bot 实例的管理器
 */
export class WeComManager {
  private bots: Map<string, BotInstance> = new Map();
  private router: AgentRouter;
  isRunning = false;

  constructor(router: AgentRouter) {
    this.router = router;
  }

  reloadBots(botConfigs: BotConfig[]): void {
    console.log(`[WeComManager] 正在重载 Bot 实例 (共 ${botConfigs.length} 个)...`);

    // 停止已存在的旧实例
    for (const bot of this.bots.values()) {
      bot.disconnect();
    }
    this.bots.clear();

    // 注册新配置
    for (const cfg of botConfigs) {
      const instance = new BotInstance(cfg, this.router);
      this.bots.set(cfg.id, instance);
      if (this.isRunning) {
        instance.connect();
      }
    }
  }

  startAll(): void {
    this.isRunning = true;
    for (const bot of this.bots.values()) {
      bot.connect();
    }
  }

  stopAll(): void {
    this.isRunning = false;
    for (const bot of this.bots.values()) {
      bot.disconnect();
    }
  }

  async notifyAll(content: string, title?: string): Promise<{ sent: number; total: number }> {
    let sent = 0;
    const total = this.bots.size;

    for (const bot of this.bots.values()) {
      const ok = await bot.notify(content, title);
      if (ok) sent++;
    }

    return { sent, total };
  }

  getStatusList(): BotInstanceStatus[] {
    return Array.from(this.bots.values()).map((b) => b.getStatus());
  }
}
