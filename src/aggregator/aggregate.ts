import type { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/types.js';
import type { DownstreamManager } from '../registry/manager.js';
import { encodeName, decodeName, encodeUri, decodeUri } from './namespace.js';

export class Aggregator {
  constructor(private readonly manager: DownstreamManager) {}

  // Advertise from every known connection's capabilities (cached while idle, live when
  // connected). No connection is established just to list.
  async listTools(): Promise<Tool[]> {
    return this.manager.entries().flatMap((c) =>
      c.capabilities.tools.map((t) => ({ ...t, name: encodeName(c.def.id, t.name) })),
    );
  }

  async listPrompts(): Promise<Prompt[]> {
    return this.manager.entries().flatMap((c) =>
      c.capabilities.prompts.map((p) => ({ ...p, name: encodeName(c.def.id, p.name) })),
    );
  }

  async listResources(): Promise<Resource[]> {
    return this.manager.entries().flatMap((c) =>
      c.capabilities.resources.map((r) => ({ ...r, uri: encodeUri(c.def.id, r.uri) })),
    );
  }

  // Routing connects on demand via the connection's own methods (ensureConnected inside).
  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<any> {
    const { serverId, name } = decodeName(qualifiedName);
    return this.connOrThrow(serverId).callTool(name, args);
  }

  async getPrompt(qualifiedName: string, args: Record<string, unknown>): Promise<any> {
    const { serverId, name } = decodeName(qualifiedName);
    return this.connOrThrow(serverId).getPrompt(name, args);
  }

  async readResource(qualifiedUri: string): Promise<any> {
    const { serverId, uri } = decodeUri(qualifiedUri);
    return this.connOrThrow(serverId).readResource(uri);
  }

  private connOrThrow(serverId: string) {
    const conn = this.manager.get(serverId);
    if (!conn) throw new Error(`unknown downstream server '${serverId}'`);
    return conn;
  }
}
