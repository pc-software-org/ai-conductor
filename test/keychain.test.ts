import { describe, it, expect } from 'vitest';
import { osKeychain, KEYCHAIN_SERVICE } from '../src/secrets/keychain.js';

// The OS keychain is environment-dependent and must NOT be touched in unit tests.
// We only assert the factory shape here; behavior is covered via injected stubs in
// the resolver/CLI tests, and verified manually against the real keychain at release.
describe('osKeychain', () => {
  it('exposes a stable service name', () => {
    expect(KEYCHAIN_SERVICE).toBe('mcp-proxy-conductor');
  });

  it('returns a backend with get/set/delete methods', () => {
    const kc = osKeychain();
    expect(typeof kc.get).toBe('function');
    expect(typeof kc.set).toBe('function');
    expect(typeof kc.delete).toBe('function');
  });
});
