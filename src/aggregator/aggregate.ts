import type { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/types.js';
import type { DownstreamManager } from '../registry/manager.js';
import { encodeName, decodeName, encodeUri, decodeUri } from './namespace.js';

export class Aggregator {
  constructor(private readonly manager: DownstreamManager) {}

  async listTools(): Promise<Tool[]> {
    return this.manager.connected().flatMap((c) =>
      c.capabilities.tools.map((t) => ({ ...t, name: encodeName(c.def.id, t.name) })),
    );
  }

  async listPrompts(): Promise<Prompt[]> {
    return this.manager.connected().flatMap((c) =>
      c.capabilities.prompts.map((p) => ({ ...p, name: encodeName(c.def.id, p.name) })),
    );
  }

  async listResources(): Promise<Resource[]> {
    return this.manager.connected().flatMap((c) =>
      c.capabilities.resources.map((r) => ({ ...r, uri: encodeUri(c.def.id, r.uri) })),
    );
  }

  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<any> {
    const { serverId, name } = decodeName(qualifiedName);
    return this.connOrThrow(serverId).client.callTool({ name, arguments: args });
  }

  async getPrompt(qualifiedName: string, args: Record<string, unknown>): Promise<any> {
    const { serverId, name } = decodeName(qualifiedName);
    return this.connOrThrow(serverId).client.getPrompt({ name, arguments: args as Record<string, string> });
  }

  async readResource(qualifiedUri: string): Promise<any> {
    const { serverId, uri } = decodeUri(qualifiedUri);
    return this.connOrThrow(serverId).client.readResource({ uri });
  }

  private connOrThrow(serverId: string) {
    const conn = this.manager.get(serverId);
    if (!conn || conn.state !== 'connected') {
      throw new Error(`downstream server '${serverId}' is not connected`);
    }
    return conn;
  }
}
