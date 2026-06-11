import { describe, it, expect } from 'vitest';
import { DownstreamManager } from '../src/registry/manager.js';
import { Aggregator } from '../src/aggregator/aggregate.js';
import { CapabilityCache } from '../src/config/capability-cache.js';
import { makeEchoServer } from './helpers/echoServer.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stdioDef = (id: string) => ({ id, enabled: true, transport: { type: 'stdio' as const, command: 'x', args: [], env: {} } });

async function setup() {
  const cache = new CapabilityCache(join(mkdtempSync(join(tmpdir(), 'agg-')), 'capabilities.json'));
  const a = await makeEchoServer('A');
  const b = await makeEchoServer('B');
  const transports: Record<string, any> = { srvA: a.clientTransport, srvB: b.clientTransport };
  const mgr = new DownstreamManager(async (def) => transports[def.id], { cache });
  await mgr.add(stdioDef('srvA'));
  await mgr.add(stdioDef('srvB'));
  return new Aggregator(mgr);
}

describe('Aggregator (lazy)', () => {
  it('lists tools from all known servers with namespaced names', async () => {
    const agg = await setup();
    const names = (await agg.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(['srvA__echo', 'srvB__echo']);
  });

  it('routes a namespaced tool call to the owning server (connecting on demand)', async () => {
    const agg = await setup();
    const res = await agg.callTool('srvB__echo', { text: 'yo' });
    expect((res.content as { text: string }[])[0].text).toBe('B:yo');
  });

  it('namespaces resource uris and routes reads back', async () => {
    const agg = await setup();
    const aRes = (await agg.listResources()).find((r) => r.name === 'greeting' && r.uri.includes('srvA'));
    expect(aRes).toBeTruthy();
    const read = await agg.readResource(aRes!.uri);
    expect((read.contents as { text: string }[])[0].text).toBe('hello from A');
  });

  it('throws a clear error for an unknown server', async () => {
    const agg = await setup();
    await expect(agg.callTool('ghost__x', {})).rejects.toThrow(/ghost/);
  });
});
