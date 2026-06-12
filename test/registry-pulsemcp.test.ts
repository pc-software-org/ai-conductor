import { describe, it, expect } from 'vitest';
import { PulseMcpRegistry } from '../src/registry-lookup/pulsemcp.js';
import type { FetchLike } from '../src/registry-lookup/types.js';

const BODY = {
  servers: [
    { name: 'Filesystem', short_description: 'Secure FS ops.', package_name: null, remotes: [] },
    { name: 'Foo', short_description: 'A foo server.', package_name: 'foo-mcp-server', remotes: [] },
    { name: 'Bar', short_description: 'Remote bar.', package_name: null, remotes: [{ url: 'https://bar.example/mcp' }] },
  ],
  total_count: 3,
};

const fakeFetch = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => body });

describe('PulseMcpRegistry', () => {
  it('maps a package_name entry to stdio, a remote entry to http, and a bare entry to no install', async () => {
    const reg = new PulseMcpRegistry(fakeFetch(BODY));
    const entries = await reg.search('x', 10);
    const fs = entries.find((e) => e.name === 'Filesystem')!;
    const foo = entries.find((e) => e.name === 'Foo')!;
    const bar = entries.find((e) => e.name === 'Bar')!;
    expect(fs.install).toBeUndefined();
    expect(fs.ref).toBe('pulsemcp:Filesystem');
    expect(foo.install).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'foo-mcp-server'], envNames: [] });
    expect(bar.install).toEqual({ type: 'http', url: 'https://bar.example/mcp' });
    expect(fs.requiredEnv).toEqual([]);
  });

  it('reports best-effort connect, no secret detection', () => {
    expect(new PulseMcpRegistry(fakeFetch(BODY)).capabilities).toEqual({ canConnect: true, canDetectSecrets: false });
  });
});
