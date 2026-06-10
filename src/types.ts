import type { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/types.js';

export type ConnState = 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';

export interface Capabilities {
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

export interface CachedCapabilities extends Capabilities {
  fetchedAt: string;
}

export interface ServerInfo {
  id: string;
  state: ConnState;
  error?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  cached: boolean;
}
