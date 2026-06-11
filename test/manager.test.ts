import { describe, it, expect, vi } from 'vitest';
import { DownstreamManager } from '../src/registry/manager.js';
import { CapabilityCache } from '../src/config/capability-cache.js';
import { makeEchoServer } from './helpers/echoServer.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stdioDef = (id: string) => ({ id, enabled: true, transport: { type: 'stdio' as const, command: 'x', args: [], env: {} } });

function cacheIn() {
  return new CapabilityCache(join(mkdtempSync(join(tmpdir(), 'mgr-')), 'capabilities.json'));
}

describe('DownstreamManager (lazy)', () => {
  it('start() does NOT connect when capabilities are cached; advertises from cache', async () => {
    const cache = cacheIn();
    await cache.save({ srvA: { tools: [{ name: 'echo' }] as any, resources: [], prompts: [], fetchedAt: 'x' } });
    let connects = 0;
    const mgr = new DownstreamManager(async () => { connects++; return (await makeEchoServer('A')).clientTransport; }, { cache });
    await mgr.start([stdioDef('srvA')]);
    expect(connects).toBe(0);
    const info = mgr.list();
    expect(info[0]).toMatchObject({ id: 'srvA', state: 'idle', cached: true, toolCount: 1 });
    await mgr.closeAll();
  });

  it('start() background-fills a server that has no cache, then it is connectable', async () => {
    const cache = cacheIn();
    const a = await makeEchoServer('A');
    const mgr = new DownstreamManager(async () => a.clientTransport, { cache });
    await mgr.start([stdioDef('srvA')]);
    await mgr.get('srvA')!.ensureConnected();
    expect(mgr.get('srvA')!.state).toBe('connected');
    expect(mgr.get('srvA')!.capabilities.tools.map((t) => t.name)).toContain('echo');
    await mgr.closeAll();
  });

  it('add() connects to validate + cache, remove() disconnects and clears the cache entry', async () => {
    const cache = cacheIn();
    const a = await makeEchoServer('A');
    const mgr = new DownstreamManager(async () => a.clientTransport, { cache });
    await mgr.add(stdioDef('srvA'));
    expect(mgr.get('srvA')!.state).toBe('connected');
    expect((await cache.load()).srvA.tools.map((t: any) => t.name)).toContain('echo');
    await mgr.remove('srvA');
    expect(mgr.get('srvA')).toBeUndefined();
    expect(await cache.load()).toEqual({});
  });

  it('entries() returns all known connections including idle ones', async () => {
    const cache = cacheIn();
    await cache.save({ srvA: { tools: [], resources: [], prompts: [], fetchedAt: 'x' } });
    const mgr = new DownstreamManager(async () => { throw new Error('no connect expected'); }, { cache });
    await mgr.start([stdioDef('srvA')]);
    expect(mgr.entries().map((c) => c.def.id)).toEqual(['srvA']);
    await mgr.closeAll();
  });
});
