import { describe, it, expect } from 'vitest';
import { OfficialRegistry } from '../src/registry-lookup/official.js';
import type { FetchLike } from '../src/registry-lookup/types.js';

const BODY = {
  servers: [
    {
      server: {
        name: 'ac.inference.sh/mcp',
        description: 'Run 150+ AI apps.',
        version: '1.0.1',
        remotes: [{ type: 'streamable-http', url: 'https://sh.inference.ac' }],
      },
    },
    {
      server: {
        name: 'com.pulsemcp/remote-filesystem',
        description: 'Remote filesystem ops.',
        version: '0.1.2',
        packages: [
          {
            registryType: 'npm',
            identifier: 'remote-filesystem-mcp-server',
            runtimeHint: 'npx',
            transport: { type: 'stdio' },
            environmentVariables: [
              { name: 'GCS_BUCKET', description: 'bucket', isRequired: true },
              { name: 'GCS_PRIVATE_KEY', description: 'key', isRequired: true, isSecret: true },
              { name: 'GCS_PROJECT_ID', description: 'project' },
            ],
          },
        ],
      },
    },
  ],
  metadata: { count: 2 },
};

function fakeFetch(body: unknown): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

describe('OfficialRegistry', () => {
  it('maps a remote entry to an http install', async () => {
    const reg = new OfficialRegistry(fakeFetch(BODY));
    const entries = await reg.search('x', 10);
    const remote = entries.find((e) => e.name === 'ac.inference.sh/mcp')!;
    expect(remote.ref).toBe('official:ac.inference.sh/mcp');
    expect(remote.install).toEqual({ type: 'http', url: 'https://sh.inference.ac' });
    expect(remote.requiredEnv).toEqual([]);
  });

  it('maps a package entry to stdio + detects required + secret env', async () => {
    const reg = new OfficialRegistry(fakeFetch(BODY));
    const entries = await reg.search('x', 10);
    const pkg = entries.find((e) => e.name === 'com.pulsemcp/remote-filesystem')!;
    expect(pkg.install).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'remote-filesystem-mcp-server'],
      envNames: ['GCS_BUCKET', 'GCS_PRIVATE_KEY', 'GCS_PROJECT_ID'],
    });
    expect(pkg.requiredEnv).toContainEqual({ name: 'GCS_PRIVATE_KEY', description: 'key', required: true, secret: true });
    expect(pkg.requiredEnv).toContainEqual({ name: 'GCS_BUCKET', description: 'bucket', required: true, secret: false });
  });

  it('throws on a non-ok HTTP response', async () => {
    const reg = new OfficialRegistry(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(reg.search('x', 10)).rejects.toThrow(/503/);
  });

  it('reports full capabilities', () => {
    expect(new OfficialRegistry(fakeFetch(BODY)).capabilities).toEqual({ canConnect: true, canDetectSecrets: true });
  });
});
