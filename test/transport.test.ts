import { describe, it, expect } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTransport } from '../src/registry/transport.js';
import { EnvSecretProvider } from '../src/secrets/provider.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const sp = new EnvSecretProvider({ TOK: 'abc' });

describe('buildTransport', () => {
  it('builds a stdio transport with resolved env', async () => {
    const t = await buildTransport(
      { id: 'a', enabled: true, transport: { type: 'stdio', command: 'echo', args: ['hi'], env: { K: '${TOK}' } } },
      sp,
    );
    expect(t).toBeInstanceOf(StdioClientTransport);
  });

  it('starts the stdio child in the configured cwd, not in the cwd of the client', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-cwd-')));
    const script = "console.log(JSON.stringify({jsonrpc:'2.0',method:'cwd',params:{cwd:process.cwd()}}))";
    const t = await buildTransport(
      { id: 'd', enabled: true, autoRetry: true, transport: { type: 'stdio', command: process.execPath, args: ['-e', script], env: {}, cwd: dir } },
      sp,
    );
    const msg = new Promise<unknown>((res, rej) => {
      t.onmessage = res;
      t.onerror = rej;
    });
    await t.start();
    try {
      expect(await msg).toMatchObject({ params: { cwd: dir } });
    } finally {
      await t.close();
    }
  });

  it('builds an http transport', async () => {
    const t = await buildTransport(
      { id: 'b', enabled: true, transport: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOK}' } } },
      sp,
    );
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('builds an sse transport', async () => {
    const t = await buildTransport(
      { id: 'c', enabled: true, transport: { type: 'sse', url: 'https://x/sse', headers: {} } },
      sp,
    );
    expect(t).toBeInstanceOf(SSEClientTransport);
  });
});
