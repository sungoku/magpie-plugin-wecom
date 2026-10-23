/**
 * Starts the local wecom-agent-bridge gateway from the Magpie plugin host.
 *
 * The plugin page is sandboxed (`connect-src 'none'`, no process APIs), so it
 * cannot start anything itself. This module runs in the Bun host instead:
 * when the user opts in, it checks the gateway's `/health`, then spawns the
 * built CLI with the host's own runtime. Using `process.execPath` means the
 * gateway runs under the same Bun that Magpie already ships, so it does not
 * depend on the GUI app's PATH or on a system Node install.
 *
 * The spawned gateway is detached: it keeps running when Magpie quits, which
 * is what makes the management page reachable outside the app. Disabling the
 * option only stops future auto-starts; it never kills a running gateway.
 *
 * Opt-in by design: `autoStartService` defaults to false because this starts
 * a process that holds WeCom credentials and can run agents.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_NOTIFY_URL = 'http://127.0.0.1:9099/notify';
const RETRY_AFTER_MS = 60_000;
const HEALTH_TIMEOUT_MS = 700;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const here = path.dirname(fileURLToPath(import.meta.url));

let lastAttempt = 0;
let inflight = null;
const warned = new Set();

/** The local service a notify URL points at, or null when it is not local. */
export function serviceTarget(notifyUrl) {
  const raw = typeof notifyUrl === 'string' && notifyUrl.trim()
    ? notifyUrl.trim()
    : DEFAULT_NOTIFY_URL;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // The gateway speaks plain HTTP. An https URL is a proxy in front of it,
  // not something this module should spawn.
  if (url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // The server binds 127.0.0.1. localhost is canonicalised below; a literal
  // IPv6 loopback would point at an address the server never listens on.
  if (host !== '127.0.0.1' && host !== 'localhost') return null;

  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  const health = new URL(url.href);
  health.pathname = '/health';
  health.search = '';
  health.hash = '';
  // The server binds 127.0.0.1 by default; prefer it over a localhost lookup
  // that may resolve to ::1 first and fail.
  if (host === 'localhost') health.hostname = '127.0.0.1';

  return {
    url: url.toString(),
    healthUrl: health.toString(),
    origin: url.origin,
    host: '127.0.0.1',
    port,
  };
}

/** Finds the checkout that contains packages/core, starting at a directory. */
export function findGateway(startDir = here) {
  let dir = realpath(startDir);

  for (let depth = 0; depth < 8; depth++) {
    const dist = path.join(dir, 'packages', 'core', 'dist', 'cli.js');
    if (isFile(dist)) return { root: dir, entry: dist };

    // A source checkout that was never built still works under Bun, which
    // runs the TypeScript directly. Node cannot.
    const src = path.join(dir, 'packages', 'core', 'src', 'cli.ts');
    if (isFile(src) && process.versions && process.versions.bun) {
      return { root: dir, entry: src };
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/** True when the service at this notify URL is our gateway and is healthy. */
export async function isServiceHealthy(notifyUrl, opts = {}) {
  const target = serviceTarget(notifyUrl);
  if (!target || typeof fetch !== 'function') return false;

  const configured = Number(opts.timeoutMs);
  const timeoutMs = Number.isFinite(configured) && configured > 0
    ? configured
    : HEALTH_TIMEOUT_MS;

  let signal;
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(timeoutMs);
    }
  } catch {
    signal = undefined;
  }

  try {
    const res = await fetch(target.healthUrl, {
      method: 'GET',
      cache: 'no-store',
      signal,
    });
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body && body.status === 'ok' && body.service === 'wecom-agent-bridge');
  } catch {
    return false;
  }
}

/**
 * Starts the gateway if the user enabled `autoStartService` and it is not
 * already running. Never throws; resolves to true only when it spawned a
 * process.
 *
 * @param {Record<string, unknown>} options Magpie plugin options
 * @param {{ force?: boolean, startDir?: string, cacheDir?: string, timeoutMs?: number }} [opts]
 */
export async function ensureService(options = {}, opts = {}) {
  try {
    if (!options || options.autoStartService !== true) return false;

    const notifyUrl = typeof options.notifyUrl === 'string' && options.notifyUrl.trim()
      ? options.notifyUrl.trim()
      : DEFAULT_NOTIFY_URL;
    const target = serviceTarget(notifyUrl);
    if (!target) return false;

    if (await isServiceHealthy(notifyUrl, opts)) return false;

    // Something else is listening on the port (another gateway build, an
    // unrelated service, or ours while it is still booting). Starting a
    // second process would only fail with EADDRINUSE.
    if (await isPortOpen(target.host, target.port)) {
      warnOnce(
        `[wecom] 端口 ${target.port} 已被其他服务占用，未自动启动本地网关。` +
        '请检查该端口上的服务，或修改 notifyUrl 与 config.json 的 server.port。'
      );
      return false;
    }

    const now = Date.now();
    if (!opts.force && now - lastAttempt < RETRY_AFTER_MS) return false;
    if (inflight) return inflight;

    lastAttempt = now;
    inflight = startGateway(target, opts)
      .catch((err) => {
        console.error('[wecom] 自动启动本地网关失败:', err && err.message ? err.message : err);
        return false;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  } catch (err) {
    console.error('[wecom] 自动启动本地网关失败:', err && err.message ? err.message : err);
    return false;
  }
}

/** Where the detached gateway writes stdout/stderr. */
export function serviceLogPath(cacheDir) {
  const base = cacheDir
    || process.env.XDG_CACHE_HOME
    || path.join(os.homedir(), '.cache');
  return path.join(base, 'wecom-agent-bridge', 'service.log');
}

async function startGateway(target, opts) {
  const app = findGateway(opts.startDir || here);
  if (!app) {
    warnOnce(
      '[wecom] 未找到 packages/core，无法自动启动本地网关。' +
      '请从本仓库/本地路径安装插件，并确认已执行 npm install。'
    );
    return false;
  }

  const configPath = findConfigPath(app.root);
  const args = [app.entry, '--config', configPath, '--port', String(target.port)];
  const logPath = serviceLogPath(opts.cacheDir);

  let fd;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateLog(logPath);
    fd = fs.openSync(logPath, 'a');
    fs.writeSync(
      fd,
      `\n[${new Date().toISOString()}] start ${process.execPath} ${args.join(' ')}\n`
    );

    const child = spawn(process.execPath, args, {
      cwd: app.root,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: childEnv(),
    });
    child.on('error', (err) => {
      console.error('[wecom] 无法启动本地网关:', err && err.message ? err.message : err);
    });
    child.unref();

    console.log(
      `[wecom] 已自动启动本地网关 (pid ${child.pid || '?'}, 端口 ${target.port})，日志: ${logPath}`
    );
    return true;
  } catch (err) {
    console.error('[wecom] 无法启动本地网关:', err && err.message ? err.message : err);
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // the child owns its duplicate of the descriptor
      }
    }
  }
}

function findConfigPath(root) {
  const fromEnv = process.env.WECOM_BRIDGE_CONFIG;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return path.resolve(root, fromEnv.trim());
  }
  for (const name of ['config.json', 'config.local.json']) {
    const candidate = path.join(root, name);
    if (isFile(candidate)) return candidate;
  }
  return path.join(root, 'config.json');
}

/**
 * GUI-launched apps often see a minimal PATH, while the agent commands
 * (`claude`, `opencode`) usually live in Homebrew or ~/.local/bin. Put those
 * first so the gateway can actually run the agents it is configured with.
 */
function childEnv() {
  const env = { ...process.env };
  const extras = [
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ];
  const parts = [];
  for (const dir of extras) {
    if (isDir(dir) && !parts.includes(dir)) parts.push(dir);
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (dir && !parts.includes(dir)) parts.push(dir);
  }
  env.PATH = parts.join(path.delimiter);
  return env;
}

function rotateLog(logPath) {
  try {
    if (fs.statSync(logPath).size > MAX_LOG_BYTES) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
    // no log yet, or a concurrent writer owns it
  }
}

/** Whether something already accepts TCP connections on this loopback port. */
function isPortOpen(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function realpath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function warnOnce(message) {
  if (warned.has(message)) return;
  warned.add(message);
  console.error(message);
}
