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
});
