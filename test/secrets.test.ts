import { describe, it, expect } from 'vitest';
import { EnvSecretProvider } from '../src/secrets/provider.js';

describe('EnvSecretProvider', () => {
  const sp = new EnvSecretProvider({ MY_TOKEN: 'sekret' });

  it('returns literal values unchanged', async () => {
    expect(await sp.resolve('plain-value')).toBe('plain-value');
  });

  it('expands ${VAR} references from the env map', async () => {
    expect(await sp.resolve('Bearer ${MY_TOKEN}')).toBe('Bearer sekret');
  });

  it('throws on unknown ${VAR}', async () => {
    await expect(sp.resolve('${NOPE}')).rejects.toThrow(/NOPE/);
  });

  it('resolveRecord expands every value', async () => {
    expect(await sp.resolveRecord({ A: '${MY_TOKEN}', B: 'lit' })).toEqual({ A: 'sekret', B: 'lit' });
  });
});
