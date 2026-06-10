import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DownstreamManager } from '../src/registry/manager.js';
import { Aggregator } from '../src/aggregator/aggregate.js';
import { MetaTools } from '../src/meta/tools.js';
import { ConfigStore } from '../src/config/store.js';
import { buildUpstreamServer } from '../src/server/upstream.js';
import { VERSION } from '../src/version.js';
import { makeEchoServer } from './helpers/echoServer.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function wired() {
  const a = await makeEchoServer('A');
  const mgr = new DownstreamManager(async () => a.clientTransport);
  await mgr.start([{ id: 'srvA', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } }]);
  const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'up-')), 'c.json'));
  await store.save({ servers: [] });
  const server = buildUpstreamServer(new Aggregator(mgr), new MetaTools(mgr, store));

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientT);
  return { client };
}

describe('upstream server', () => {
  it('exposes downstream tools AND meta-tools in tools/list', async () => {
    const { client } = await wired();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('srvA__echo');
    expect(names).toContain('add_server');
  });

  it('routes a namespaced tool call downstream', async () => {
    const { client } = await wired();
    const res = await client.callTool({ name: 'srvA__echo', arguments: { text: 'hey' } });
    expect((res.content as { text: string }[])[0].text).toBe('A:hey');
  });

  it('routes a meta-tool call (list_servers)', async () => {
    const { client } = await wired();
    const res = await client.callTool({ name: 'list_servers', arguments: {} });
    expect((res.content as { text: string }[])[0].text).toContain('srvA');
  });

  it('reports serverInfo version from the package version', async () => {
    const { client } = await wired();
    expect(client.getServerVersion()).toEqual({ name: 'ai-conductor', version: VERSION });
  });
});
