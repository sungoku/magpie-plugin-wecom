#!/usr/bin/env node
import { Command } from 'commander';
import { startBridge, VERSION } from './index.js';
import { startMcpServer } from './mcp/server.js';

const program = new Command();

program
  .name('wecom-bridge')
  .description('Universal Enterprise WeChat Bridge for AI Coding Agents')
  .version(VERSION)
  .option('-c, --config <path>', '指定配置文件路径 (默认查找当前目录下的 config.json)')
  .option('-p, --port <number>', '指定本地管理/通知 HTTP 端口 (默认 9099)', (val) => parseInt(val, 10))
  .action((options) => {
    startBridge(undefined, { configPath: options.config, port: options.port });
  });

program
  .command('mcp')
  .description('以 stdio MCP Server 运行，向 Claude Code / Cursor 提供 wecom_send_notification 工具')
  .option('-p, --port <number>', '本地通知服务端口 (默认 9099)', (val) => parseInt(val, 10))
  .action((options) => {
    startMcpServer(options.port || 9099);
  });

program.parse(process.argv);
