"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRouter = void 0;
class AgentRouter {
    adapters = new Map();
    defaultAgentName;
    constructor(defaultAgentName) {
        this.defaultAgentName = defaultAgentName;
    }
    register(adapter) {
        this.adapters.set(adapter.name.toLowerCase(), adapter);
        console.log(`[Router] 注册 Agent: ${adapter.name} (${adapter.description || '无描述'})`);
    }
    getAdapter(name) {
        return this.adapters.get(name.toLowerCase());
    }
    listAgents() {
        return Array.from(this.adapters.values()).map((a) => ({
            name: a.name,
            description: a.description,
        }));
    }
    async dispatch(rawMessage, userId, onStream, defaultAgentOverride) {
        const trimmed = rawMessage.trim();
        if (!trimmed) {
            return '⚠️ 请输入要执行的指令内容。';
        }
        const effectiveDefault = defaultAgentOverride || this.defaultAgentName;
        // 检查是否有帮助指令
        if (trimmed === '/help' || trimmed === '帮助') {
            const list = this.listAgents()
                .map((a) => `• \`/${a.name}\`: ${a.description || '自定义命令'}`)
                .join('\n');
            return `🤖 **WeCom Agent Bridge 指令帮助**\n\n支持的 Agent 列表:\n${list}\n\n当前默认执行 Agent: \`${effectiveDefault}\`\n\n💡 示例:\n- 直接发送: \`查看当前目录\` (由 ${effectiveDefault} 执行)\n- 指定 Agent: \`/sh git status\` 或 \`/claude 优化代码\``;
        }
        let agentName = effectiveDefault;
        let prompt = trimmed;
        // 匹配前缀命令，如 /claude 帮我分析代码 或 /sh ls
        if (trimmed.startsWith('/')) {
            const match = trimmed.match(/^\/([a-zA-Z0-9_-]+)\s*(.*)$/s);
            if (match) {
                const candidate = match[1].toLowerCase();
                if (this.adapters.has(candidate)) {
                    agentName = candidate;
                    prompt = match[2].trim();
                }
            }
        }
        const adapter = this.adapters.get(agentName);
        if (!adapter) {
            return `❌ 未找到名称为 "${agentName}" 的 Agent 适配器。\n发送 /help 查看所有可用 Agent。`;
        }
        if (!prompt) {
            return `⚠️ 请在 /${agentName} 后面输入具体要执行的任务描述。`;
        }
        const context = {
            userId,
            commandName: agentName,
            prompt,
        };
        return adapter.execute(prompt, context, onStream);
    }
}
exports.AgentRouter = AgentRouter;
//# sourceMappingURL=router.js.map