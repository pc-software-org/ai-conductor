import { describe, it, expect } from 'vitest';
import { buildServerDefinition, normalizeId } from '../src/registry-lookup/install.js';
import type { RegistryEntry } from '../src/registry-lookup/types.js';

const stdioEntry = (requiredEnv: RegistryEntry['requiredEnv']): RegistryEntry => ({
  source: 'official', ref: 'official:x/fs', name: 'x/fs', description: '',
  install: { type: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], envNames: requiredEnv.map((e) => e.name) },
  requiredEnv,
});

describe('normalizeId', () => {
  it('strips disallowed chars (including the __ delimiter source) to hyphens', () => {
    expect(normalizeId('com.pulsemcp/remote_filesystem')).toBe('com-pulsemcp-remote-filesystem');
  });
});

describe('buildServerDefinition', () => {
  it('returns guidance when there is no install info', () => {
    const entry: RegistryEntry = { source: 'glama', ref: 'glama:y', name: 'y', description: '', requiredEnv: [] };
    const plan = buildServerDefinition(entry, {});
    expect(plan.def).toBeUndefined();
    expect(plan.guidance).toMatch(/no run details|add_server/i);
  });

  it('asks for secret bindings when a required secret is unbound', () => {
    const plan = buildServerDefinition(stdioEntry([{ name: 'GCS_PRIVATE_KEY', required: true, secret: true }]), {});
    expect(plan.def).toBeUndefined();
    expect(plan.guidance).toMatch(/GCS_PRIVATE_KEY/);
    expect(plan.guidance).toMatch(/secret set/);
  });

  it('wires bound secrets as ${keychain:...} env refs', () => {
    const plan = buildServerDefinition(
      stdioEntry([{ name: 'GCS_PRIVATE_KEY', required: true, secret: true }]),
      { id: 'fs', secretBindings: { GCS_PRIVATE_KEY: 'gcs-key' } },
    );
    expect(plan.guidance).toBeUndefined();
    expect(plan.def).toEqual({
      id: 'fs', enabled: true,
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], env: { GCS_PRIVATE_KEY: '${keychain:gcs-key}' } },
    });
  });

  it('asks for required non-secret env when not provided', () => {
    const plan = buildServerDefinition(stdioEntry([{ name: 'GCS_BUCKET', required: true, secret: false }]), { id: 'fs' });
    expect(plan.def).toBeUndefined();
    expect(plan.guidance).toMatch(/GCS_BUCKET/);
  });

  it('puts provided non-secret env into the definition', () => {
    const plan = buildServerDefinition(stdioEntry([{ name: 'GCS_BUCKET', required: true, secret: false }]), { id: 'fs', env: { GCS_BUCKET: 'my-bucket' } });
    expect(plan.def).toMatchObject({ transport: { env: { GCS_BUCKET: 'my-bucket' } } });
  });

  it('builds a remote (http) definition with no env handling', () => {
    const entry: RegistryEntry = {
      source: 'official', ref: 'official:r', name: 'r', description: '',
      install: { type: 'http', url: 'https://r.example/mcp' }, requiredEnv: [],
    };
    const plan = buildServerDefinition(entry, { id: 'r' });
    expect(plan.def).toEqual({ id: 'r', enabled: true, transport: { type: 'http', url: 'https://r.example/mcp' } });
  });
});
