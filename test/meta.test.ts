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

// Wie setup(), aber die Factory baut pro Verbindungsaufbau einen frischen
// Echo-Server. Noetig fuer Neustarts: die schliessen den alten Transport, und ein
// InMemoryTransport ist danach nicht wiederverwendbar. Zaehlt die Aufbauten mit.
async function setupReconnectable() {
  let connects = 0;
  const mgr = new DownstreamManager(async () => {
    connects++;
    return (await makeEchoServer('A')).clientTransport;
  });
  const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'meta-')), 'c.json'));
  await store.save({ servers: [] });
  return { meta: new MetaTools(mgr, store), mgr, store, connects: () => connects };
}

describe('MetaTools', () => {
  it('exposes add_server / remove_server / list_servers tool definitions', async () => {
    const { meta } = await setup();
    expect(meta.definitions().map((t) => t.name).sort()).toEqual([
      'add_server', 'install_from_registry', 'list_registries', 'list_servers', 'remove_server', 'restart_server', 'search_registry',
    ]);
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

  it('exposes a restart_server tool definition', async () => {
    const { meta } = await setup();
    expect(meta.definitions().map((t) => t.name)).toContain('restart_server');
  });

  it('restart_server reconnects the server AND leaves the stored config untouched', async () => {
    const { meta, mgr, store, connects } = await setupReconnectable();
    await meta.call('add_server', {
      id: 'srvA',
      transport: { type: 'stdio', command: 'x', args: ['--flag'], env: { TOKEN: 'v' } },
    });
    const before = await store.load();

    const res = await meta.call('restart_server', { id: 'srvA' });

    expect(res.isError).toBeFalsy();
    expect(mgr.get('srvA')?.state).toBe('connected');
    // Zweiter Aufbau = der Server lief wirklich neu an, nicht nur ein No-op.
    expect(connects()).toBe(2);
    // Kern der Sache: die persistierte Definition bleibt Zeichen fuer Zeichen gleich.
    expect(await store.load()).toEqual(before);
  });

  it('restart_server reports an unknown id as a tool error', async () => {
    const { meta } = await setupReconnectable();
    const res = await meta.call('restart_server', { id: 'nope' });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('nope');
  });

  it('restart_server reports the state instead of throwing when the server fails to come back', async () => {
    const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'meta-')), 'c.json'));
    let attempt = 0;
    const mgr = new DownstreamManager(async () => {
      attempt++;
      if (attempt === 1) return (await makeEchoServer('A')).clientTransport;
      throw new Error('downstream is down');
    });
    const meta = new MetaTools(mgr, store);
    await store.save({ servers: [] });
    await meta.call('add_server', { id: 'srvA', transport: { type: 'stdio', command: 'x' } });

    const res = await meta.call('restart_server', { id: 'srvA' });

    expect(res.isError).toBeFalsy();
    expect((res.content[0] as { text: string }).text).toContain('error');
    // Die Definition darf auch dann nicht verloren gehen, wenn der Neustart scheitert.
    expect((await store.load()).servers.map((s) => s.id)).toEqual(['srvA']);
  });

  it('add_server passes autoRetry through to the stored definition', async () => {
    const { meta, store } = await setupReconnectable();
    await meta.call('add_server', {
      id: 'srvA',
      autoRetry: false,
      transport: { type: 'stdio', command: 'x' },
    });
    expect((await store.load()).servers[0].autoRetry).toBe(false);
  });

  it('add_server leaves autoRetry on when it is not mentioned', async () => {
    const { meta, store } = await setupReconnectable();
    await meta.call('add_server', { id: 'srvA', transport: { type: 'stdio', command: 'x' } });
    expect((await store.load()).servers[0].autoRetry).toBe(true);
  });
});
