import type { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/types.js';

export type ConnState = 'connecting' | 'connected' | 'error' | 'disconnected';

export interface Capabilities {
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

export interface ServerInfo {
  id: string;
  state: ConnState;
  error?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
}
