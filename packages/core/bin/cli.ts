#!/usr/bin/env node
import { Command } from 'commander';
import { startBridge } from '../src/index.js';

const program = new Command();

program
  .name('wecom-agent-bridge')
  .description('Universal Enterprise WeChat Bridge for AI Coding Agents')
  .version('1.0.0')
  .option('-c, --config <path>', '指定配置文件路径 (默认查找当前目录下的 config.json)')
  .option('-p, --port <number>', '指定本地通知 HTTP 接口端口 (默认 9099)', (val) => parseInt(val, 10))
  .action((options) => {
    startBridge({
      server: options.port ? { port: options.port } : undefined,
    });
  });

program.parse(process.argv);
