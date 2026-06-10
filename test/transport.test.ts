import { describe, it, expect } from 'vitest';
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
