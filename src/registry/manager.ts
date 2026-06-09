import { DownstreamConnection, type TransportFactory } from './connection.js';
import type { ServerDefinition } from '../config/schema.js';
import type { ServerInfo } from '../types.js';

export class DownstreamManager {
  private readonly conns = new Map<string, DownstreamConnection>();

  constructor(
    private readonly transportFactory: TransportFactory,
    private readonly onChange: () => void = () => undefined,
  ) {}

  // Connect all enabled definitions. Individual failures are captured as error state;
  // they never reject start() or prevent other servers from connecting.
  async start(defs: ServerDefinition[]): Promise<void> {
    await Promise.all(defs.filter((d) => d.enabled).map((d) => this.connectOne(d)));
  }

  private async connectOne(def: ServerDefinition): Promise<DownstreamConnection> {
    const conn = new DownstreamConnection(def, this.transportFactory, this.onChange);
    this.conns.set(def.id, conn);
    await conn.connect().catch(() => undefined); // state already set to 'error' inside connect()
    this.onChange();
    return conn;
  }

  async add(def: ServerDefinition): Promise<DownstreamConnection> {
    if (this.conns.has(def.id)) throw new Error(`server '${def.id}' already exists`);
    return this.connectOne(def);
  }

  async remove(id: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) return;
    await conn.close();
    this.conns.delete(id);
    this.onChange();
  }

  get(id: string): DownstreamConnection | undefined {
    return this.conns.get(id);
  }

  connected(): DownstreamConnection[] {
    return [...this.conns.values()].filter((c) => c.state === 'connected');
  }

  list(): ServerInfo[] {
    return [...this.conns.values()].map((c) => ({
      id: c.def.id,
      state: c.state,
      error: c.error,
      toolCount: c.capabilities.tools.length,
      resourceCount: c.capabilities.resources.length,
      promptCount: c.capabilities.prompts.length,
    }));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => c.close()));
    this.conns.clear();
  }
}
