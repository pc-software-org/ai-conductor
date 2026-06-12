import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaTools } from '../src/meta/tools.js';
import { DownstreamManager } from '../src/registry/manager.js';
import { ConfigStore } from '../src/config/store.js';
import { CapabilityCache } from '../src/config/capability-cache.js';
import { RegistryAggregator } from '../src/registry-lookup/aggregate.js';
import type { RegistrySource, RegistryEntry } from '../src/registry-lookup/types.js';
import { makeEchoServer } from './helpers/echoServer.js';

function source(id: string, entries: RegistryEntry[]): RegistrySource {
  return { id, title: id, capabilities: { canConnect: id === 'official', canDetectSecrets: id === 'official' }, search: async () => entries };
}

async function setup(entries: RegistryEntry[]) {
  const a = await makeEchoServer('A');
  const mgr = new DownstreamManager(async () => a.clientTransport, {
    cache: new CapabilityCache(join(mkdtempSync(join(tmpdir(), 'mr-')), 'c.json')),
  });
  const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'mr-')), 'cfg.json'));
  await store.save({ servers: [] });
  const agg = new RegistryAggregator([source('official', entries), source('glama', [])]);
  return { meta: new MetaTools(mgr, store, agg), mgr, store };
}

const installable: RegistryEntry = {
  source: 'official', ref: 'official:demo/echo', name: 'demo/echo', description: 'echo',
  install: { type: 'stdio', command: 'npx', args: ['-y', 'echo-mcp'], envNames: [] }, requiredEnv: [],
};

describe('registry meta-tools', () => {
  it('list_registries returns sources with capability flags', async () => {
    const { meta } = await setup([]);
    const res = await meta.call('list_registries', {});
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.find((r: any) => r.id === 'official')).toMatchObject({ canConnect: true, canDetectSecrets: true });
  });

  it('search_registry defaults to official and returns refs', async () => {
    const { meta } = await setup([installable]);
    const res = await meta.call('search_registry', { query: 'echo' });
    expect((res.content[0] as { text: string }).text).toContain('official:demo/echo');
  });

  it('install_from_registry connects an installable entry and persists it', async () => {
    const { meta, mgr, store } = await setup([installable]);
    await meta.call('search_registry', { query: 'echo' });
    const res = await meta.call('install_from_registry', { ref: 'official:demo/echo', id: 'echo' });
    expect(res.isError).toBeFalsy();
    expect(mgr.get('echo')?.state).toBe('connected');
    expect((await store.load()).servers.map((s) => s.id)).toContain('echo');
  });

  it('install_from_registry errors for an unknown ref', async () => {
    const { meta } = await setup([installable]);
    const res = await meta.call('install_from_registry', { ref: 'official:does-not-exist' });
    expect(res.isError).toBe(true);
  });
});
