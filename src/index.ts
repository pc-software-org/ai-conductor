import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ConfigStore } from './config/store.js';
import { EnvSecretProvider } from './secrets/provider.js';
import { buildTransport } from './registry/transport.js';
import { DownstreamManager } from './registry/manager.js';
import { Aggregator } from './aggregator/aggregate.js';
import { MetaTools } from './meta/tools.js';
import { buildUpstreamServer } from './server/upstream.js';
import type { TransportFactory } from './registry/connection.js';

export interface ConductorOptions {
  store?: ConfigStore;
  transportFactory?: TransportFactory;
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

  const manager = new DownstreamManager(transportFactory, onChange);
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

// CLI entry: only runs when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  createConductor()
    .then((c) => c.start())
    .catch((err) => {
      console.error('ai-conductor failed to start:', err);
      process.exit(1);
    });
}
