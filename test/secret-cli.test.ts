import { describe, it, expect } from 'vitest';
import { runSecretCommand } from '../src/cli/secret.js';
import type { KeychainBackend } from '../src/secrets/keychain.js';

function recordingBackend() {
  const store: Record<string, string> = {};
  const calls: string[] = [];
  const backend: KeychainBackend = {
    get: (n) => (n in store ? store[n] : null),
    set: (n, v) => { store[n] = v; calls.push(`set:${n}`); },
    delete: (n) => { const had = n in store; delete store[n]; calls.push(`del:${n}`); return had; },
  };
  return { backend, store, calls };
}

function io(secret: string) {
  const lines: string[] = [];
  return { io: { readSecret: async () => secret, out: (m: string) => lines.push(m) }, lines };
}

describe('runSecretCommand', () => {
  it('set stores the value in the keychain', async () => {
    const { backend, store } = recordingBackend();
    const { io: i, lines } = io('s3cret');
    const code = await runSecretCommand(['set', 'ur-token'], backend, i);
    expect(code).toBe(0);
    expect(store['ur-token']).toBe('s3cret');
    expect(lines.join('\n')).toContain('ur-token');
  });

  it('set never echoes the secret value in its output', async () => {
    const { backend } = recordingBackend();
    const { io: i, lines } = io('super-secret-value');
    await runSecretCommand(['set', 'ur-token'], backend, i);
    expect(lines.join('\n')).not.toContain('super-secret-value');
  });

  it('set with an empty value aborts with a non-zero code and stores nothing', async () => {
    const { backend, calls } = recordingBackend();
    const { io: i } = io('');
    const code = await runSecretCommand(['set', 'ur-token'], backend, i);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  it('rm deletes the entry', async () => {
    const { backend, store } = recordingBackend();
    store['ur-token'] = 'x';
    const { io: i } = io('');
    const code = await runSecretCommand(['rm', 'ur-token'], backend, i);
    expect(code).toBe(0);
    expect('ur-token' in store).toBe(false);
  });

  it('prints usage and returns non-zero for an unknown subcommand or missing name', async () => {
    const { backend } = recordingBackend();
    const { io: i, lines } = io('');
    expect(await runSecretCommand(['bogus'], backend, i)).toBe(1);
    expect(await runSecretCommand(['set'], backend, i)).toBe(1);
    expect(lines.join('\n').toLowerCase()).toContain('usage');
  });
});
