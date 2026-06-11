import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownstreamManager } from '../src/registry/manager.js';
import { ConfigStore } from '../src/config/store.js';
import { MetaTools } from '../src/meta/tools.js';
import { makeEchoServer } from './helpers/echoServer.js';

async function setup() {
  const a = await makeEchoServer('A');
  const transports: Record<string, any> = { srvA: a.clientTransport };
  const mgr = new DownstreamManager(async (def) => {
    const t = transports[def.id];
    if (!t) throw new Error(`no transport for ${def.id}`);
    return t;
  });
  const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'meta-')), 'c.json'));
  await store.save({ servers: [] });
  return { meta: new MetaTools(mgr, store), mgr, store };
}

describe('MetaTools', () => {
  it('exposes add_server / remove_server / list_servers tool definitions', async () => {
    const { meta } = await setup();
    expect(meta.definitions().map((t) => t.name).sort()).toEqual(['add_server', 'list_servers', 'remove_server']);
  });

  it('add_server connects the server AND persists it', async () => {
    const { meta, mgr, store } = await setup();
    const res = await meta.call('add_server', { id: 'srvA', transport: { type: 'stdio', command: 'x' } });
    expect(res.isError).toBeFalsy();
    expect(mgr.get('srvA')?.state).toBe('connected');
    expect((await store.load()).servers.map((s) => s.id)).toEqual(['srvA']);
  });

  it('list_servers reports state and cached flag as JSON', async () => {
    const { meta } = await setup();
    await meta.call('add_server', { id: 'srvA', transport: { type: 'stdio', command: 'x' } });
    const res = await meta.call('list_servers', {});
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed[0]).toMatchObject({ id: 'srvA', state: 'connected', cached: false });
  });

  it('remove_server disconnects AND removes from the store', async () => {
    const { meta, mgr, store } = await setup();
    await meta.call('add_server', { id: 'srvA', transport: { type: 'stdio', command: 'x' } });
    await meta.call('remove_server', { id: 'srvA' });
    expect(mgr.get('srvA')).toBeUndefined();
    expect((await store.load()).servers).toEqual([]);
  });

  it('rejects an invalid add_server payload with a tool error (not a throw)', async () => {
    const { meta } = await setup();
    const res = await meta.call('add_server', { id: 'bad__id', transport: { type: 'stdio', command: 'x' } });
    expect(res.isError).toBe(true);
  });
});
