import type { AgentAdapter, StreamCallback } from '../adapters/types.js';
export declare class AgentRouter {
    private adapters;
    private defaultAgentName;
    constructor(defaultAgentName: string);
    register(adapter: AgentAdapter): void;
    getAdapter(name: string): AgentAdapter | undefined;
    listAgents(): {
        name: string;
        description?: string;
    }[];
    dispatch(rawMessage: string, userId: string, onStream?: StreamCallback, defaultAgentOverride?: string): Promise<string>;
}
//# sourceMappingURL=router.d.ts.map