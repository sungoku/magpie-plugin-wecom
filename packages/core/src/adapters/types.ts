export interface StreamCallback {
  (chunk: string, fullOutput: string): Promise<void> | void;
}

export interface AgentContext {
  userId: string;
  commandName: string;
  prompt: string;
}

export interface AgentAdapter {
  name: string;
  description?: string;
  execute(
    prompt: string,
    context: AgentContext,
    onStream?: StreamCallback
  ): Promise<string>;
}
