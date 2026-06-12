import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ServerDefinitionSchema } from '../config/schema.js';
import type { ConfigStore } from '../config/store.js';
import type { DownstreamManager } from '../registry/manager.js';
import type { RegistryAggregator } from '../registry-lookup/aggregate.js';
import type { RegistryEntry } from '../registry-lookup/types.js';
import { buildServerDefinition } from '../registry-lookup/install.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export class MetaTools {
  private readonly lastEntries = new Map<string, RegistryEntry>();

  constructor(
    private readonly manager: DownstreamManager,
    private readonly store: ConfigStore,
    private readonly registry?: RegistryAggregator,
  ) {}

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
      {
        name: 'list_registries',
        description: 'List available MCP registries to search, with capability flags (canConnect, canDetectSecrets).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'search_registry',
        description: 'Search MCP registries for servers. Defaults to the official registry; pass sources (from list_registries) to include others.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' }, description: 'Registry ids to search; default ["official"]' },
            limit: { type: 'number', description: 'Max results per source (default 10)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'install_from_registry',
        description: 'Install a server found via search_registry by its ref. Provide secretBindings { ENV_NAME: keychain-name } for required secrets, and env { ENV_NAME: value } for required non-secret env.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'The ref from a search_registry result' },
            id: { type: 'string', description: 'Optional downstream id (defaults to a normalized name)' },
            env: { type: 'object' },
            secretBindings: { type: 'object' },
          },
          required: ['ref'],
        },
      },
    ];
  }

  has(name: string): boolean {
    return ['add_server', 'remove_server', 'list_servers', 'list_registries', 'search_registry', 'install_from_registry'].includes(name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (name === 'add_server') return await this.addServer(args);
      if (name === 'remove_server') return await this.removeServer(args);
      if (name === 'list_servers') return ok(JSON.stringify(this.manager.list(), null, 2));
      if (name === 'list_registries') return this.listRegistries();
      if (name === 'search_registry') return await this.searchRegistry(args);
      if (name === 'install_from_registry') return await this.installFromRegistry(args);
      return fail(`unknown meta-tool: ${name}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async persistAndAdd(def: ReturnType<typeof ServerDefinitionSchema.parse>): Promise<void> {
    await this.manager.add(def);
    const config = await this.store.load();
    config.servers = [...config.servers.filter((s) => s.id !== def.id), def];
    await this.store.save(config);
  }

  private async addServer(args: Record<string, unknown>): Promise<ToolResult> {
    const def = ServerDefinitionSchema.parse({ id: args.id, transport: args.transport, enabled: true });
    await this.persistAndAdd(def);
    return ok(`server '${def.id}' added (state: ${this.manager.get(def.id)?.state}).`);
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

  private listRegistries(): ToolResult {
    if (!this.registry) return fail('registry lookup is not configured');
    return ok(JSON.stringify(this.registry.list(), null, 2));
  }

  private async searchRegistry(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.registry) return fail('registry lookup is not configured');
    const query = String(args.query ?? '');
    if (!query) return fail('query is required');
    const sources = Array.isArray(args.sources) ? (args.sources as string[]) : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    const outcome = await this.registry.search(query, sources, limit);
    for (const e of outcome.entries) this.lastEntries.set(e.ref, e);
    const view = outcome.entries.map((e) => ({
      ref: e.ref,
      source: e.source,
      name: e.name,
      description: e.description,
      connectable: e.install !== undefined,
      requiredSecrets: e.requiredEnv.filter((v) => v.secret).map((v) => v.name),
    }));
    const payload: Record<string, unknown> = { results: view };
    if (outcome.errors.length > 0) payload.errors = outcome.errors;
    return ok(JSON.stringify(payload, null, 2));
  }

  private async installFromRegistry(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.registry) return fail('registry lookup is not configured');
    const ref = String(args.ref ?? '');
    const entry = this.lastEntries.get(ref);
    if (!entry) return fail(`unknown ref '${ref}'. Run search_registry first and use a ref from its results.`);
    const plan = buildServerDefinition(entry, {
      id: args.id ? String(args.id) : undefined,
      env: (args.env as Record<string, string>) ?? undefined,
      secretBindings: (args.secretBindings as Record<string, string>) ?? undefined,
    });
    if (!plan.def) return ok(plan.guidance ?? 'cannot install this entry automatically.');
    const def = ServerDefinitionSchema.parse(plan.def);
    if (this.manager.get(def.id)) return fail(`server '${def.id}' already exists`);
    await this.persistAndAdd(def);
    return ok(`installed '${def.id}' from ${entry.source} (state: ${this.manager.get(def.id)?.state}).`);
  }
}
