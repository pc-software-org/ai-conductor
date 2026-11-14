import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { ServerDefinitionSchema, ConfigSchema } from '../src/config/schema.js';

describe('ServerDefinitionSchema', () => {
  it('accepts a valid stdio definition and applies defaults', () => {
    const def = ServerDefinitionSchema.parse({
      id: 'github',
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'] },
    });
    expect(def.enabled).toBe(true);
    expect(def.transport).toMatchObject({ type: 'stdio', env: {} });
  });

  it('defaults autoRetry to true, so existing configs keep the retry without being touched', () => {
    const def = ServerDefinitionSchema.parse({ id: 'github', transport: { type: 'stdio', command: 'npx' } });
    expect(def.autoRetry).toBe(true);
  });

  it('accepts autoRetry: false to switch the retry off for one server', () => {
    const def = ServerDefinitionSchema.parse({
      id: 'flaky',
      autoRetry: false,
      transport: { type: 'stdio', command: 'npx' },
    });
    expect(def.autoRetry).toBe(false);
  });

  it('accepts an absolute cwd for stdio and leaves it unset by default', () => {
    const dir = resolve('srv');
    const def = ServerDefinitionSchema.parse({ id: 'a', transport: { type: 'stdio', command: 'x', cwd: dir } });
    expect(def.transport).toMatchObject({ cwd: dir });
    const plain = ServerDefinitionSchema.parse({ id: 'b', transport: { type: 'stdio', command: 'x' } });
    expect(plain.transport).not.toHaveProperty('cwd');
  });

  it('rejects a relative cwd, it would depend on the working directory of the client', () => {
    expect(() =>
      ServerDefinitionSchema.parse({ id: 'a', transport: { type: 'stdio', command: 'x', cwd: 'srv' } }),
    ).toThrow();
  });

  it('rejects ids containing underscores (namespacing safety)', () => {
    expect(() =>
      ServerDefinitionSchema.parse({ id: 'gh__x', transport: { type: 'stdio', command: 'x' } }),
    ).toThrow();
  });

  it('accepts http and sse definitions', () => {
    expect(ServerDefinitionSchema.parse({ id: 'a', transport: { type: 'http', url: 'https://x/mcp' } }).transport.type).toBe('http');
    expect(ServerDefinitionSchema.parse({ id: 'b', transport: { type: 'sse', url: 'https://x/sse' } }).transport.type).toBe('sse');
  });

  it('ConfigSchema defaults servers to []', () => {
    expect(ConfigSchema.parse({})).toEqual({ servers: [] });
  });
});
