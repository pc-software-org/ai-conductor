import { describe, it, expect } from 'vitest';
import { SecretResolver } from '../src/secrets/provider.js';
import type { KeychainBackend } from '../src/secrets/keychain.js';

function fakeKeychain(entries: Record<string, string>): KeychainBackend {
  return {
    get: (name) => (name in entries ? entries[name] : null),
    set: () => undefined,
    delete: () => true,
  };
}

describe('SecretResolver', () => {
  const resolver = new SecretResolver({
    env: { TOK: 'envval' },
    keychain: fakeKeychain({ 'ur-token': 'kcval' }),
  });

  it('resolves bare ${VAR} from env (back-compat)', async () => {
    expect(await resolver.resolve('Bearer ${TOK}')).toBe('Bearer envval');
  });

  it('resolves ${env:VAR} explicitly', async () => {
    expect(await resolver.resolve('${env:TOK}')).toBe('envval');
  });

  it('resolves ${keychain:NAME} from the keychain', async () => {
    expect(await resolver.resolve('Bearer ${keychain:ur-token}')).toBe('Bearer kcval');
  });

  it('resolves multiple mixed placeholders in one value', async () => {
    expect(await resolver.resolve('${env:TOK}:${keychain:ur-token}')).toBe('envval:kcval');
  });

  it('throws on an unknown scheme', async () => {
    await expect(resolver.resolve('${vault:x}')).rejects.toThrow(/vault/);
  });

  it('throws (with the name) when a keychain secret is missing', async () => {
    await expect(resolver.resolve('${keychain:nope}')).rejects.toThrow(/nope/);
  });

  it('throws when a keychain ref is used but no keychain is configured', async () => {
    await expect(new SecretResolver({ env: {} }).resolve('${keychain:x}')).rejects.toThrow(/keychain/);
  });

  it('resolveRecord expands every value', async () => {
    expect(await resolver.resolveRecord({ A: '${TOK}', B: '${keychain:ur-token}' })).toEqual({ A: 'envval', B: 'kcval' });
  });
});
