import type { AgentAdapter, AgentContext, StreamCallback } from './types.js';
export declare class CliAdapter implements AgentAdapter {
    name: string;
    description?: string;
    private commandTemplate;
    constructor(name: string, commandTemplate: string, description?: string);
    execute(prompt: string, context: AgentContext, onStream?: StreamCallback): Promise<string>;
}
//# sourceMappingURL=cli-adapter.d.ts.map