import type { WeComManager } from '../wecom/client.js';
export interface NotifyServerOptions {
    port: number;
    host?: string;
    wecomManager: WeComManager;
}
export declare class NotifyServer {
    private port;
    private host;
    private wecomManager;
    private server;
    private startTime;
    constructor(options: NotifyServerOptions);
    start(): void;
    private readBody;
    stop(): void;
}
//# sourceMappingURL=notify-server.d.ts.map