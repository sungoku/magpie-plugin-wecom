import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type { AgentRouter } from '../router/router.js';
import type { BotConfig } from '../config.js';
import { truncateUtf8 } from '../util.js';

/** The SDK allows at most 20480 bytes per stream reply; keep a margin. */
const MAX_STREAM_BYTES = 20000;
const MAX_PROGRESS_BYTES = 18000;

export interface BotInstanceStatus {
  id: string;
  name: string;
  botId: string;
  defaultAgent: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  lastError?: string;
  connectedAt?: string;
  allowedUsersCount: number;
}

export class BotInstance {
  config: BotConfig;
  private client: any;
  private router: AgentRouter;
  status: 'connected' | 'connecting' | 'disconnected' | 'error' = 'disconnected';
  lastError?: string;
  connectedAt?: string;
  lastActiveFrame: any = null;
  /** Where an unsolicited notification goes: the group chat, or the user. */
  private notifyTarget = '';
  private connecting = false;

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
    if (this.connecting || this.status === 'connected') return;

    this.connecting = true;
    this.status = 'connecting';
    console.log(`[Bot:${this.config.name}] 正在建立长连接 (BotID: ${this.config.botId})...`);

    this.client = new WSClient({
      botId: this.config.botId,
      secret: this.config.secret,
    });

    this.client.on('authenticated', () => {
      this.connecting = false;
      this.status = 'connected';
      this.connectedAt = new Date().toISOString();
      this.lastError = undefined;
      console.log(`🎉 [Bot:${this.config.name}] 认证成功并在线！(绑定 Agent: ${this.config.defaultAgent})`);
    });

    this.client.on('error', (err: any) => {
      this.connecting = false;
      this.status = 'error';
      this.lastError = err?.message || String(err);
      console.error(`❌ [Bot:${this.config.name}] 连接错误:`, this.lastError);
    });

    // The SDK emits "disconnected" (not "disconnect").
    this.client.on('disconnected', (reason: string) => {
      this.connecting = false;
      this.status = 'disconnected';
      this.lastError = reason ? `连接断开: ${reason}` : undefined;
      console.warn(`⚠️ [Bot:${this.config.name}] 连接已断开${reason ? ` (${reason})` : ''}，SDK 自动重连中...`);
    });

    this.client.on('reconnecting', (attempt: number) => {
      this.status = 'connecting';
      console.warn(`🔄 [Bot:${this.config.name}] 正在重连（第 ${attempt} 次）...`);
    });

    this.client.on('message.text', async (frame: any) => {
      await this.handleMessage(frame);
    });

    try {
      this.client.connect();
    } catch (e: any) {
      this.connecting = false;
      this.status = 'error';
      this.lastError = e?.message || String(e);
      console.error(`❌ [Bot:${this.config.name}] 建立连接失败:`, this.lastError);
    }
  }

  disconnect(): void {
    if (this.client) {
      try {
        if (typeof this.client.removeAllListeners === 'function') {
          this.client.removeAllListeners();
        }
        if (typeof this.client.disconnect === 'function') {
          this.client.disconnect();
        } else if (typeof this.client.close === 'function') {
          this.client.close();
        }
      } catch {
        // ignore
      }
      this.client = undefined;
      this.connecting = false;
      this.status = 'disconnected';
      console.log(`🛑 [Bot:${this.config.name}] 已断开连接。`);
    }
  }

  private isAllowed(fromUser: string): boolean {
    const list = this.config.allowedUsers || [];
    if (list.length === 0) return true;
    return list.includes('*') || list.includes(fromUser);
  }

  /** Reply on the stream opened for a message, within the SDK's byte limit. */
  private async reply(frame: any, streamId: string, content: string, finish: boolean): Promise<void> {
    await this.client.replyStream(
      frame,
      streamId,
      truncateUtf8(content, MAX_STREAM_BYTES),
      finish
    );
  }

  private async handleMessage(frame: any): Promise<void> {
    const rawContent = frame.body?.text?.content || '';
    // SDK: body.from is { userid: string }; older shapes used a bare string.
    const fromRaw = frame.body?.from;
    const fromUser: string =
      (typeof fromRaw === 'string' ? fromRaw : fromRaw?.userid) || 'unknown';

    console.log(`\n📨 [${this.config.name}] 收到用户 [${fromUser}] 指令: "${rawContent}"`);

    if (!rawContent.trim()) {
      return;
    }

    if (!this.isAllowed(fromUser)) {
      console.warn(`⛔ [${this.config.name}] 用户 [${fromUser}] 不在白名单中，拒绝响应。`);
      const streamId = generateReqId('stream');
      try {
        await this.reply(
          frame,
          streamId,
          `⛔ [${this.config.name}]：抱歉，你的账号 (${fromUser}) 未在授权白名单中。`,
          true
        );
      } catch {
        // ignore
      }
      return;
    }

    // Only an authorised conversation may become the target of an active
    // notification or of the reply-channel fallback. Setting this before the
    // whitelist check would leak later task summaries to a rejected user.
    this.lastActiveFrame = frame;
    this.notifyTarget = frame.body?.chatid || (fromUser !== 'unknown' ? fromUser : '');

    const streamId = generateReqId('stream');
    try {
      await this.reply(
        frame,
        streamId,
        `⏳ **[${this.config.name}] 已接收指令**\n> ${truncateUtf8(rawContent, 500)}\n\n正在调用 Agent (\`${this.config.defaultAgent}\`) 处理...`,
        false
      );

      const promptToExecute = this.config.promptPrefix
        ? `${this.config.promptPrefix}\n\n${rawContent}`
        : rawContent;

      const finalResult = await this.router.dispatch(
        promptToExecute,
        fromUser,
        async (_chunk, fullOutput) => {
          const preview = truncateUtf8(fullOutput, MAX_PROGRESS_BYTES, 'both');
          try {
            await this.reply(
              frame,
              streamId,
              `⚙️ **[${this.config.name}] 执行中...**\n\`\`\`text\n${preview}\n\`\`\``,
              false
            );
          } catch (e) {
            console.error(`[Bot:${this.config.name}] 进度推送失败:`, e);
          }
        },
        this.config.defaultAgent
      );

      await this.reply(frame, streamId, finalResult, true);
      console.log(`✅ [${this.config.name}] 结果已推回企微。`);
    } catch (err: any) {
      console.error(`❌ [${this.config.name}] 任务失败:`, err);
      try {
        await this.reply(
          frame,
          streamId,
          `❌ 执行出错: ${truncateUtf8(String(err?.message || err), 1500)}`,
          true
        );
      } catch {
        // ignore
      }
    }
  }

  /**
   * Push a notification. Prefer the SDK's active-send channel; fall back to
   * replying on the last message's req_id for older SDK behaviour.
   */
  async notify(content: string, title?: string): Promise<boolean> {
    if (this.status !== 'connected') return false;

    const message = title ? `🔔 **${title}**\n\n${content}` : `🔔 ${content}`;
    const text = truncateUtf8(message, MAX_STREAM_BYTES);

    if (this.notifyTarget && typeof this.client?.sendMessage === 'function') {
      try {
        await this.client.sendMessage(this.notifyTarget, {
          msgtype: 'markdown',
          markdown: { content: text },
        });
        return true;
      } catch (e) {
        console.warn(`[Bot:${this.config.name}] 主动推送失败，尝试回复通道:`, e);
      }
    }

    if (!this.lastActiveFrame) return false;
    try {
      const streamId = generateReqId('notify');
      await this.reply(this.lastActiveFrame, streamId, text, true);
      return true;
    } catch {
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
      allowedUsersCount: (this.config.allowedUsers || []).length,
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

    for (const bot of this.bots.values()) {
      bot.disconnect();
    }
    this.bots.clear();

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
