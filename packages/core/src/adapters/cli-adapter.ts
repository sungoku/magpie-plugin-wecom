import { spawn } from 'node:child_process';
import type { AgentAdapter, AgentContext, StreamCallback } from './types.js';
import { truncateUtf8 } from '../util.js';

// 清除终端 ANSI 颜色转义字符，避免微信显示乱码
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

/**
 * Quote a value for a POSIX shell. Single quotes stop `$(...)`, backticks and
 * `;` from being expanded, so a prompt can never become shell syntax.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the command line for an agent template.
 *
 * A template that is exactly `{prompt}` is the "raw shell" agent: the prompt
 * itself is the command, as configured intentionally. Every other template
 * gets the prompt as a single, safely quoted argument; templates written as
 * `"{prompt}"` or `'{prompt}'` are handled so the user's quotes are not
 * passed to the program as part of the prompt.
 */
export function buildCommand(template: string, prompt: string): string {
  const tpl = template.trim();
  if (tpl === '{prompt}') {
    // Explicit opt-in to raw shell execution (the `sh` agent).
    return prompt;
  }

  const quoted = shellQuote(prompt);
  if (template.includes('"{prompt}"')) {
    return template.replaceAll('"{prompt}"', quoted);
  }
  if (template.includes("'{prompt}'")) {
    return template.replaceAll("'{prompt}'", quoted);
  }
  if (template.includes('{prompt}')) {
    return template.replaceAll('{prompt}', quoted);
  }
  return `${template} ${quoted}`;
}

const MAX_ACCUMULATED_BYTES = 4 * 1024 * 1024;

export class CliAdapter implements AgentAdapter {
  name: string;
  description?: string;
  private commandTemplate: string;
  private timeoutSec: number;

  constructor(name: string, commandTemplate: string, description?: string, timeoutSec = 900) {
    this.name = name;
    this.commandTemplate = commandTemplate;
    this.description = description;
    this.timeoutSec = Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec : 900;
  }

  async execute(
    prompt: string,
    context: AgentContext,
    onStream?: StreamCallback
  ): Promise<string> {
    const fullCommand = buildCommand(this.commandTemplate, prompt);

    console.log(`[CliAdapter:${this.name}] 正在执行命令: ${fullCommand}`);

    return new Promise((resolve) => {
      let accumulatedOutput = '';
      let lastStreamTime = Date.now();
      let settled = false;
      const throttleInterval = 800; // 每 800ms 向企微更新一次进度，避免频控

      const child = spawn(fullCommand, {
        shell: true,
        // On POSIX, make the child a process-group leader so a timeout can
        // stop the whole tree (shell + claude/opencode), not just the shell.
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          FORCE_COLOR: '0', // 尽量禁用颜色输出
        },
      });

      const killTree = (signal: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          // already gone
        }
      };

      const finish = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(message);
      };

      const timer = setTimeout(() => {
        killTree('SIGTERM');
        setTimeout(() => killTree('SIGKILL'), 3000).unref();
        finish(
          `⏱️ 执行超时（${this.timeoutSec} 秒），已终止。\n\n已捕获输出:\n${truncateUtf8(accumulatedOutput.trim(), 4000)}`
        );
      }, this.timeoutSec * 1000);
      timer.unref?.();

      const handleData = async (data: Buffer) => {
        const text = stripAnsi(data.toString('utf-8'));
        accumulatedOutput += text;
        if (Buffer.byteLength(accumulatedOutput, 'utf8') > MAX_ACCUMULATED_BYTES) {
          // Keep the tail: build logs are more useful at the end.
          accumulatedOutput = truncateUtf8(accumulatedOutput, MAX_ACCUMULATED_BYTES, 'both');
        }

        const now = Date.now();
        if (onStream && now - lastStreamTime >= throttleInterval) {
          lastStreamTime = now;
          try {
            await onStream(text, accumulatedOutput);
          } catch (e) {
            console.error(`[CliAdapter:${this.name}] 流式推送出错:`, e);
          }
        }
      };

      child.stdout.on('data', handleData);
      child.stderr.on('data', handleData);

      child.on('close', (code) => {
        const cleanOutput = accumulatedOutput.trim();
        const finalMessage = code === 0
          ? (cleanOutput || '✅ 任务执行成功（无输出内容）')
          : `⚠️ 命令退出码: ${code}\n\n输出日志:\n${cleanOutput}`;

        finish(finalMessage);
      });

      child.on('error', (err) => {
        finish(`❌ 执行异常: ${err.message}`);
      });
    });
  }
}
