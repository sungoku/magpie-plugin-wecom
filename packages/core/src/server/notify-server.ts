import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  loadConfig,
  publicConfig,
  sanitizeBots,
  saveConfig,
  type BridgeConfig,
} from '../config.js';
import type { WeComManager } from '../wecom/client.js';

export interface NotifyServerOptions {
  port: number;
  host?: string;
  wecomManager: WeComManager;
  configPath?: string;
  /** Fixed token for tests; otherwise a fresh one per process. */
  token?: string;
}

const MAX_CONFIG_BODY = 512 * 1024;
const MAX_NOTIFY_BODY = 64 * 1024;
const VERSION = '1.1.1';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function hashToken(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function tokenMatches(given: string, expected: string): boolean {
  return crypto.timingSafeEqual(hashToken(given), hashToken(expected));
}

function resolveUiDir(): string | null {
  const candidates = [
    process.env.WECOM_UI_DIR,
    path.resolve(__dirname, '../../../magpie-plugin/page'),
    path.resolve(process.cwd(), 'packages/magpie-plugin/page'),
    path.resolve(process.cwd(), 'page'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

export class NotifyServer {
  private port: number;
  private host: string;
  private wecomManager: WeComManager;
  private configPath?: string;
  private server: http.Server | null = null;
  private startTime = Date.now();
  private uiDir = resolveUiDir();
  /** Only the management UI served by this process holds this token. */
  readonly token: string;

  constructor(options: NotifyServerOptions) {
    this.port = options.port;
    this.host = options.host || '127.0.0.1';
    this.wecomManager = options.wecomManager;
    this.configPath = options.configPath;
    this.token = options.token || crypto.randomBytes(24).toString('hex');
  }

  start(): void {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        if (status >= 500) console.error('[NotifyServer] 请求失败:', err);
        if (!res.headersSent) {
          this.sendJson(res, status, { error: message });
        } else {
          res.end();
        }
      });
    });

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ [NotifyServer] 端口 ${this.port} 已被占用，请停止占用该端口的进程或修改 server.port。`);
      } else {
        console.error('[NotifyServer] 服务错误:', err);
      }
    });

    this.server.listen(this.port, this.host, () => {
      console.log(`🌐 [NotifyServer] 本地管理与通知接口就绪: http://${this.host}:${this.port}`);
      console.log(`🖥️  管理界面: http://${this.host}:${this.port}/ （由本服务启动，页面内已注入本次会话令牌）`);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    // CORS is only for the management API. The UI may run in a sandboxed
    // frame (Origin: null), so `*` is used together with the token.
    if (pathname.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token, Authorization');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      this.requireToken(req);
    }

    // 1. Health check (no token: it reveals nothing)
    if (req.method === 'GET' && pathname === '/health') {
      this.sendJson(res, 200, { status: 'ok', service: 'wecom-agent-bridge', version: VERSION });
      return;
    }

    // 2. Management UI and its assets
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      this.serveIndex(res);
      return;
    }
    if (req.method === 'GET' && (pathname === '/app.js' || pathname === '/style.css' || pathname === '/icon.svg')) {
      this.serveAsset(res, pathname.slice(1));
      return;
    }
    if (req.method === 'GET' && pathname === '/_magpie/bridge.js') {
      // Standalone pages also include the bridge script; answer with an
      // empty module so it is not a 404 in the browser console.
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('// standalone mode: magpie bridge not available\n');
      return;
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 3. Status API (for the UI)
    if (req.method === 'GET' && pathname === '/api/status') {
      this.sendJson(res, 200, {
        running: this.wecomManager.isRunning,
        uptimeSec: Math.round((Date.now() - this.startTime) / 1000),
        version: VERSION,
        bots: this.wecomManager.getStatusList(),
      });
      return;
    }

    // 4. Config read API: secrets are never returned
    if (req.method === 'GET' && pathname === '/api/config') {
      const config = loadConfig(this.configPath);
      this.sendJson(res, 200, publicConfig(config));
      return;
    }

    // 5. Config save API: masked/empty secrets keep the one on disk
    if (req.method === 'POST' && pathname === '/api/config') {
      this.requireJson(req);
      const body = await this.readBody(req, MAX_CONFIG_BODY);
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(body || '{}');
      } catch {
        throw new HttpError(400, '请求体不是合法 JSON');
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new HttpError(400, '配置必须是 JSON 对象');
      }

      const current = loadConfig(this.configPath);
      const bots = sanitizeBots(input.bots ?? current.bots, current.bots, current.agents);
      const next: BridgeConfig = { ...current, bots };

      saveConfig(next, this.configPath);
      this.wecomManager.reloadBots(bots);

      this.sendJson(res, 200, {
        success: true,
        message: '配置已更新并热重载',
        config: publicConfig(next),
      });
      return;
    }

    // 6. Service start/stop
    if (req.method === 'POST' && pathname === '/api/service/start') {
      this.wecomManager.startAll();
      this.sendJson(res, 200, { success: true, running: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/service/stop') {
      this.wecomManager.stopAll();
      this.sendJson(res, 200, { success: true, running: false });
      return;
    }

    // 7. Notification endpoint, used by the Magpie hooks module.
    // No CORS headers and JSON only, so a random web page cannot use it.
    if (req.method === 'POST' && pathname === '/notify') {
      this.requireJson(req);
      const body = await this.readBody(req, MAX_NOTIFY_BODY);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(body || '{}');
      } catch {
        throw new HttpError(400, '请求体不是合法 JSON');
      }
      const content = String(data.content || data.message || '');
      const title = data.title ? String(data.title) : undefined;
      if (!content.trim()) throw new HttpError(400, 'content 字段不能为空');

      const { sent, total } = await this.wecomManager.notifyAll(content, title);
      this.sendJson(res, sent > 0 ? 200 : 503, { success: sent > 0, sent, total });
      return;
    }

    if (pathname.startsWith('/api/')) {
      throw new HttpError(404, 'Not Found');
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }

  private requireToken(req: http.IncomingMessage): void {
    const header = req.headers['x-bridge-token'];
    const auth = req.headers.authorization;
    const given = Array.isArray(header)
      ? header[0]
      : header || (auth?.startsWith('Bearer ') ? auth.slice(7) : '');
    if (!given || !tokenMatches(given, this.token)) {
      throw new HttpError(401, `未授权：缺少或错误的管理令牌，请从 http://${this.host}:${this.port}/ 打开管理界面`);
    }
  }

  private requireJson(req: http.IncomingMessage): void {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      throw new HttpError(415, 'Content-Type 必须是 application/json');
    }
  }

  private serveIndex(res: http.ServerResponse): void {
    if (!this.uiDir) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('未找到管理界面文件（packages/magpie-plugin/page/index.html）。');
      return;
    }
    let html = fs.readFileSync(path.join(this.uiDir, 'index.html'), 'utf-8');
    // The token is injected only into the page this server serves. Magpie
    // serves the same file as a static asset and never sees the token.
    const injected = [
      '<script>',
      `window.__BRIDGE_TOKEN__=${JSON.stringify(this.token)};`,
      'window.__BRIDGE_BASE__="";',
      `window.__BRIDGE_VERSION__=${JSON.stringify(VERSION)};`,
      '</script>',
    ].join('');
    html = html.replace(/<\/head>/i, `${injected}\n</head>`);

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(html);
  }

  private serveAsset(res: http.ServerResponse, name: string): void {
    if (!this.uiDir) {
      res.writeHead(404);
      res.end();
      return;
    }
    const file = path.join(this.uiDir, name);
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = name.endsWith('.css')
      ? 'text/css; charset=utf-8'
      : name.endsWith('.svg')
        ? 'image/svg+xml'
        : 'text/javascript; charset=utf-8';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(file));
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  }

  private readBody(req: http.IncomingMessage, limit: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          tooLarge = true;
          return;
        }
        body += chunk.toString('utf-8');
      });
      req.on('end', () => {
        if (tooLarge) reject(new HttpError(413, '请求体过大'));
        else resolve(body);
      });
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
