import { describe, it, expect } from 'vitest';
import { GlamaRegistry } from '../src/registry-lookup/glama.js';
import type { FetchLike } from '../src/registry-lookup/types.js';

const BODY = {
  servers: [
    {
      id: 'bac8fgtyyo',
      name: 'mcp-catalogue',
      namespace: 'Aidan-Kay',
      slug: 'mcp-catalogue',
      description: 'A browse-first MCP middleware.',
      repository: { url: 'https://github.com/Aidan-Kay/mcp-catalogue' },
      environmentVariablesJsonSchema: {
        type: 'object',
        properties: { MCP_CATALOGUE_AUTH_TOKEN: { description: 'Bearer token', type: 'string' } },
        required: ['MCP_CATALOGUE_AUTH_TOKEN'],
      },
    },
  ],
  pageInfo: { hasNextPage: true },
};

const fakeFetch = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => body });

describe('GlamaRegistry', () => {
  it('maps an entry: ref by id, env from JSON schema (no secret flag), no install', async () => {
    const reg = new GlamaRegistry(fakeFetch(BODY));
    const [e] = await reg.search('x', 10);
    expect(e.ref).toBe('glama:bac8fgtyyo');
    expect(e.name).toBe('mcp-catalogue');
    expect(e.install).toBeUndefined();
    expect(e.requiredEnv).toEqual([
      { name: 'MCP_CATALOGUE_AUTH_TOKEN', description: 'Bearer token', required: true, secret: false },
    ]);
  });

  it('reports discovery-only capabilities', () => {
    expect(new GlamaRegistry(fakeFetch(BODY)).capabilities).toEqual({ canConnect: false, canDetectSecrets: false });
  });

  it('throws on a non-ok response', async () => {
    const reg = new GlamaRegistry(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(reg.search('x', 10)).rejects.toThrow(/500/);
  });
});
