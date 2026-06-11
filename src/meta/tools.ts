import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ServerDefinitionSchema } from '../config/schema.js';
import type { ConfigStore } from '../config/store.js';
import type { DownstreamManager } from '../registry/manager.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export class MetaTools {
  constructor(private readonly manager: DownstreamManager, private readonly store: ConfigStore) {}

  definitions(): Tool[] {
    return [
      {
        name: 'add_server',
        description: 'Add and connect a downstream MCP server at runtime. Persists across restarts.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique id, alphanumeric/hyphen, no underscores' },
            transport: { type: 'object', description: 'Transport: {type:"stdio",command,args?,env?} | {type:"http",url,headers?} | {type:"sse",url,headers?}' },
          },
          required: ['id', 'transport'],
        },
      },
      {
        name: 'remove_server',
        description: 'Disconnect and remove a downstream MCP server. Persists across restarts.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      {
        name: 'list_servers',
        description: 'List managed downstream servers: connection state (idle/connected/error), whether capabilities are served from cache, and capability counts.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  has(name: string): boolean {
    return ['add_server', 'remove_server', 'list_servers'].includes(name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (name === 'add_server') return await this.addServer(args);
      if (name === 'remove_server') return await this.removeServer(args);
      if (name === 'list_servers') return ok(JSON.stringify(this.manager.list(), null, 2));
      return fail(`unknown meta-tool: ${name}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async addServer(args: Record<string, unknown>): Promise<ToolResult> {
    const def = ServerDefinitionSchema.parse({ id: args.id, transport: args.transport, enabled: true });
    await this.manager.add(def);
    const config = await this.store.load();
    config.servers = [...config.servers.filter((s) => s.id !== def.id), def];
    await this.store.save(config);
    const state = this.manager.get(def.id)?.state;
    return ok(`server '${def.id}' added (state: ${state}).`);
  }

  private async removeServer(args: Record<string, unknown>): Promise<ToolResult> {
    const id = String(args.id ?? '');
    if (!id) return fail('id is required');
    await this.manager.remove(id);
    const config = await this.store.load();
    config.servers = config.servers.filter((s) => s.id !== id);
    await this.store.save(config);
    return ok(`server '${id}' removed.`);
  }
}
