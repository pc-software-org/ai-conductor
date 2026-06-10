import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ConfigStore } from './config/store.js';
import { EnvSecretProvider } from './secrets/provider.js';
import { buildTransport } from './registry/transport.js';
import { DownstreamManager } from './registry/manager.js';
import { Aggregator } from './aggregator/aggregate.js';
import { MetaTools } from './meta/tools.js';
import { buildUpstreamServer } from './server/upstream.js';
import { CapabilityCache } from './config/capability-cache.js';
import type { TransportFactory } from './registry/connection.js';

export interface ConductorOptions {
  store?: ConfigStore;
  transportFactory?: TransportFactory;
  cache?: CapabilityCache;
  idleMs?: number;
}

export interface Conductor {
  server: Server;
  manager: DownstreamManager;
  start(): Promise<void>;
}

export async function createConductor(opts: ConductorOptions = {}): Promise<Conductor> {
  const store = opts.store ?? new ConfigStore();
  const secrets = new EnvSecretProvider();
  const transportFactory = opts.transportFactory ?? ((def) => buildTransport(def, secrets));

  // onChange fires whenever capabilities/state change → tell the upstream client.
  let server: Server | undefined;
  const onChange = () => {
    if (!server?.transport) return; // upstream not connected yet → client will fetch fresh lists on connect
    server.sendToolListChanged();
    server.sendResourceListChanged();
    server.sendPromptListChanged();
  };

  const cache = opts.cache ?? new CapabilityCache();
  const idleMs = opts.idleMs ?? Number(process.env.CONDUCTOR_IDLE_TIMEOUT_MS ?? 300_000);
  const manager = new DownstreamManager(transportFactory, { onChange, cache, idleMs });
  const aggregator = new Aggregator(manager);
  const meta = new MetaTools(manager, store);
  server = buildUpstreamServer(aggregator, meta);

  const config = await store.load();
  await manager.start(config.servers);

  return {
    server: server!,
    manager,
    async start() {
      await server!.connect(new StdioServerTransport());
    },
  };
}

// True when this module is the process entry point. Resolves symlinks on both sides so
// it works when launched via an npm/npx bin symlink (where process.argv[1] is the symlink
// path but import.meta.url is the resolved real path). A naive string compare fails there.
export function isMainModule(argv1: string | undefined, importMetaUrl: string): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }
}

// CLI entry: only runs when executed directly (not when imported by tests).
if (isMainModule(process.argv[1], import.meta.url)) {
  createConductor()
    .then((c) => c.start())
    .catch((err) => {
      console.error('ai-conductor failed to start:', err);
      process.exit(1);
    });
}
