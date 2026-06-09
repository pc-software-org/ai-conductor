import { describe, it, expect } from 'vitest';
import { encodeName, decodeName, encodeUri, decodeUri } from '../src/aggregator/namespace.js';

describe('name namespacing', () => {
  it('round-trips a simple name', () => {
    expect(decodeName(encodeName('github', 'create_issue'))).toEqual({ serverId: 'github', name: 'create_issue' });
  });

  it('preserves original names that themselves contain the delimiter', () => {
    const q = encodeName('srv', 'weird__tool');
    expect(decodeName(q)).toEqual({ serverId: 'srv', name: 'weird__tool' });
  });

  it('throws when there is no delimiter (a meta-tool name)', () => {
    expect(() => decodeName('add_server')).toThrow();
  });
});

describe('uri namespacing', () => {
  it('round-trips an arbitrary resource uri', () => {
    const q = encodeUri('files', 'file:///etc/hosts?x=1');
    expect(decodeUri(q)).toEqual({ serverId: 'files', uri: 'file:///etc/hosts?x=1' });
  });
});
