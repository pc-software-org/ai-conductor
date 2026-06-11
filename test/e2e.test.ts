import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConductor } from '../src/index.js';
import { ConfigStore } from '../src/config/store.js';
import { makeEchoServer } from './helpers/echoServer.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('end-to-end', () => {
  it('add_server makes new tools appear and emits tools listChanged upstream', async () => {
    const a = await makeEchoServer('A');
    const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'e2e-')), 'c.json'));
    await store.save({ servers: [] });

    // Inject a transport factory so 'srvA' resolves to our in-memory echo server.
    const conductor = await createConductor({
      store,
      transportFactory: async () => a.clientTransport,
    });

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await conductor.server.connect(serverT);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientT);

    let changed = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed = true; });

    expect((await client.listTools()).tools.some((t) => t.name === 'srvA__echo')).toBe(false);
    await client.callTool({ name: 'add_server', arguments: { id: 'srvA', transport: { type: 'stdio', command: 'x' } } });

    // allow notification to flush
    await new Promise((r) => setTimeout(r, 20));
    expect(changed).toBe(true);
    expect((await client.listTools()).tools.some((t) => t.name === 'srvA__echo')).toBe(true);
  });

  it('cold start with pre-existing servers does not throw "Not connected"', async () => {
    const a = await makeEchoServer('A');
    const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'e2e-cold-')), 'c.json'));
    // Pre-populate the store with a server so manager.start() connects it before
    // the upstream server has a transport — this is the cold-start scenario.
    await store.save({
      servers: [{ id: 'srvA', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } }],
    });

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // createConductor triggers manager.start with a pre-existing server BEFORE
      // the upstream server is connected to a transport.  With the bug, onChange
      // fires during connect and throws "Not connected".
      const conductor = await createConductor({
        store,
        transportFactory: async () => a.clientTransport,
      });

      // Give the microtask queue a tick so any stray rejection can surface.
      await new Promise((r) => setTimeout(r, 20));

      // Now connect an upstream client and verify srvA__echo is present.
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await conductor.server.connect(serverT);
      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(clientT);

      expect((await client.listTools()).tools.some((t) => t.name === 'srvA__echo')).toBe(true);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandledRejections).toHaveLength(0);
  });

  it('serves a cached tool while idle and connects lazily only on the actual call', async () => {
    const a = await makeEchoServer('A');
    const dir = mkdtempSync(join(tmpdir(), 'lazy-'));
    const store = new ConfigStore(join(dir, 'config.json'));
    await store.save({ servers: [{ id: 'srvA', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } }] });
    const { CapabilityCache } = await import('../src/config/capability-cache.js');
    const cache = new CapabilityCache(join(dir, 'capabilities.json'));
    await cache.save({ srvA: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] as any, resources: [], prompts: [], fetchedAt: 'x' } });

    let connects = 0;
    const conductor = await createConductor({
      store,
      cache,
      idleMs: 0,
      transportFactory: async () => { connects++; return a.clientTransport; },
    });

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await conductor.server.connect(serverT);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientT);

    expect((await client.listTools()).tools.some((t) => t.name === 'srvA__echo')).toBe(true);
    expect(connects).toBe(0);

    const res = await client.callTool({ name: 'srvA__echo', arguments: { text: 'lazy' } });
    expect((res.content as { text: string }[])[0].text).toBe('A:lazy');
    expect(connects).toBe(1);
  });
});
