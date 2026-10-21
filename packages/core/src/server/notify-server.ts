import http from 'node:http';
import { loadConfig, saveConfig, type BridgeConfig } from '../config.js';
import type { WeComManager } from '../wecom/client.js';

export interface NotifyServerOptions {
  port: number;
  host?: string;
  wecomManager: WeComManager;
}

export class NotifyServer {
  private port: number;
  private host: string;
  private wecomManager: WeComManager;
  private server: http.Server | null = null;
  private startTime = Date.now();

  constructor(options: NotifyServerOptions) {
    this.port = options.port;
    this.host = options.host || '127.0.0.1';
    this.wecomManager = options.wecomManager;
  }

  start(): void {
    this.server = http.createServer(async (req, res) => {
      // 允许跨域或来自 Magpie 界面调用
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, PUT, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url?.split('?')[0];

      // 1. 健康检查
      if (req.method === 'GET' && url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', service: 'wecom-agent-bridge' }));
        return;
      }

      // 2. 状态查询 API (供 Magpie 插件 UI 读取)
      if (req.method === 'GET' && url === '/api/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            running: this.wecomManager.isRunning,
            uptimeSec: Math.round((Date.now() - this.startTime) / 1000),
            bots: this.wecomManager.getStatusList(),
          })
        );
        return;
      }

      // 3. 配置读取 API
      if (req.method === 'GET' && url === '/api/config') {
        const config = loadConfig();
        // 隐藏真实的 secret 前缀保护安全
        const safeConfig = {
          ...config,
          bots: config.bots.map((b) => ({
            ...b,
            secretMasked: b.secret ? `${b.secret.slice(0, 4)}••••${b.secret.slice(-4)}` : '',
          })),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(safeConfig));
        return;
      }

      // 4. 配置保存 API (供 Magpie 插件 UI 保存)
      if (req.method === 'POST' && url === '/api/config') {
        const body = await this.readBody(req);
        try {
          const newConfig: Partial<BridgeConfig> = JSON.parse(body);
          saveConfig(newConfig);

          // 热重载 Bot 实例
          if (newConfig.bots) {
            this.wecomManager.reloadBots(newConfig.bots);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: '配置已更新并热重载' }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // 5. 服务启动/连接控制
      if (req.method === 'POST' && url === '/api/service/start') {
        this.wecomManager.startAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, running: true }));
        return;
      }

      // 6. 服务停止/断开控制
      if (req.method === 'POST' && url === '/api/service/stop') {
        this.wecomManager.stopAll();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, running: false }));
        return;
      }

      // 7. 发送主动通知
      if (req.method === 'POST' && url === '/notify') {
        const body = await this.readBody(req);
        try {
          const data = JSON.parse(body || '{}');
          const content = data.content || data.message || '';
          const title = data.title;

          if (!content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'content 字段不能为空' }));
            return;
          }

          const { sent, total } = await this.wecomManager.notifyAll(content, title);
          res.writeHead(sent > 0 ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: sent > 0, sent, total }));
        } catch (e: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    this.server.listen(this.port, this.host, () => {
      console.log(`🌐 [NotifyServer] 本地管理与通知接口就绪: http://${this.host}:${this.port}`);
    });
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
