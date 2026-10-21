import { spawn } from 'node:child_process';
import type { AgentAdapter, AgentContext, StreamCallback } from './types.js';

// 清除终端 ANSI 颜色转义字符，避免微信显示乱码
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

export class CliAdapter implements AgentAdapter {
  name: string;
  description?: string;
  private commandTemplate: string;

  constructor(name: string, commandTemplate: string, description?: string) {
    this.name = name;
    this.commandTemplate = commandTemplate;
    this.description = description;
  }

  async execute(
    prompt: string,
    context: AgentContext,
    onStream?: StreamCallback
  ): Promise<string> {
    const fullCommand = this.commandTemplate.includes('{prompt}')
      ? this.commandTemplate.replace('{prompt}', prompt.replace(/"/g, '\\"'))
      : `${this.commandTemplate} "${prompt.replace(/"/g, '\\"')}"`;

    console.log(`[CliAdapter:${this.name}] 正在执行命令: ${fullCommand}`);

    return new Promise((resolve) => {
      let accumulatedOutput = '';
      let lastStreamTime = Date.now();
      const throttleInterval = 800; // 每 800ms 向企微更新一次进度，避免频控

      const child = spawn(fullCommand, {
        shell: true,
        env: {
          ...process.env,
          FORCE_COLOR: '0', // 尽量禁用颜色输出
        },
      });

      const handleData = async (data: Buffer) => {
        const text = stripAnsi(data.toString('utf-8'));
        accumulatedOutput += text;

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
        
        resolve(finalMessage);
      });

      child.on('error', (err) => {
        resolve(`❌ 执行异常: ${err.message}`);
      });
    });
  }
}
