import { DownstreamConnection, type TransportFactory } from './connection.js';
import type { CapabilityCache, CapabilityCacheMap } from '../config/capability-cache.js';
import type { ServerDefinition } from '../config/schema.js';
import type { ServerInfo } from '../types.js';

export interface ManagerOptions {
  onChange?: () => void;
  cache?: CapabilityCache;
  idleMs?: number;
}

export class DownstreamManager {
  private readonly conns = new Map<string, DownstreamConnection>();
  private readonly onChange: () => void;
  private readonly cache?: CapabilityCache;
  private readonly idleMs: number;
  private cacheMap: CapabilityCacheMap = {};

  constructor(
    private readonly transportFactory: TransportFactory,
    opts: ManagerOptions = {},
  ) {
    this.onChange = opts.onChange ?? (() => undefined);
    this.cache = opts.cache;
    this.idleMs = opts.idleMs ?? 0;
  }

  // Non-blocking: create idle connections hydrated from cache; only servers with no cached
  // capabilities are background-filled (fire-and-forget) so they can be advertised.
  async start(defs: ServerDefinition[]): Promise<void> {
    this.cacheMap = this.cache ? await this.cache.load() : {};
    for (const def of defs.filter((d) => d.enabled)) {
      const conn = this.createConn(def);
      this.conns.set(def.id, conn);
      if (!this.cacheMap[def.id]) {
        void conn.ensureConnected().catch(() => undefined); // populate caps in the background
      }
    }
  }

  async add(def: ServerDefinition): Promise<DownstreamConnection> {
    if (this.conns.has(def.id)) throw new Error(`server '${def.id}' already exists`);
    const conn = this.createConn(def);
    this.conns.set(def.id, conn);
    await conn.ensureConnected().catch(() => undefined); // validate + fetch caps
    // Persist caps synchronously after connect so the cache is up-to-date on return.
    if (conn.state === 'connected' && this.cache) {
      this.cacheMap[def.id] = {
        tools: conn.capabilities.tools,
        resources: conn.capabilities.resources,
        prompts: conn.capabilities.prompts,
        fetchedAt: new Date().toISOString(),
      };
      await this.cache.save(this.cacheMap).catch(() => undefined);
    }
    this.onChange();
    return conn;
  }

  async remove(id: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) return;
    await conn.close();
    this.conns.delete(id);
    delete this.cacheMap[id];
    if (this.cache) await this.cache.save(this.cacheMap).catch(() => undefined);
    this.onChange();
  }

  get(id: string): DownstreamConnection | undefined {
    return this.conns.get(id);
  }

  entries(): DownstreamConnection[] {
    return [...this.conns.values()];
  }

  list(): ServerInfo[] {
    return [...this.conns.values()].map((c) => ({
      id: c.def.id,
      state: c.state,
      error: c.error,
      toolCount: c.capabilities.tools.length,
      resourceCount: c.capabilities.resources.length,
      promptCount: c.capabilities.prompts.length,
      cached: c.hydrated,
    }));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => c.close()));
    this.conns.clear();
  }

  private createConn(def: ServerDefinition): DownstreamConnection {
    return new DownstreamConnection(def, this.transportFactory, {
      idleMs: this.idleMs,
      cachedCaps: this.cacheMap[def.id],
      onChange: () => this.onConnChange(def.id),
    });
  }

  // A connection reports a capability/state change: persist live caps to the cache and
  // propagate listChanged upstream.
  private onConnChange(id: string): void {
    const conn = this.conns.get(id);
    if (conn && conn.state === 'connected') {
      this.cacheMap[id] = {
        tools: conn.capabilities.tools,
        resources: conn.capabilities.resources,
        prompts: conn.capabilities.prompts,
        fetchedAt: new Date().toISOString(),
      };
      if (this.cache) void this.cache.save(this.cacheMap).catch(() => undefined);
    }
    this.onChange();
  }
}
