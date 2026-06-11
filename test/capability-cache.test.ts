import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CapabilityCache } from '../src/config/capability-cache.js';

describe('CapabilityCache', () => {
  let path: string;
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), 'caps-')), 'capabilities.json');
  });

  it('returns {} when the file is missing', async () => {
    expect(await new CapabilityCache(path).load()).toEqual({});
  });

  it('round-trips a saved map', async () => {
    const cache = new CapabilityCache(path);
    const map = {
      srvA: { tools: [{ name: 'echo' }], resources: [], prompts: [], fetchedAt: '2026-01-01T00:00:00.000Z' },
    };
    await cache.save(map);
    expect(await new CapabilityCache(path).load()).toEqual(map);
  });

  it('treats a corrupt file as empty (cache is disposable, never fatal)', async () => {
    const cache = new CapabilityCache(path);
    await cache.save({});
    writeFileSync(path, '{ not json');
    expect(await cache.load()).toEqual({});
  });
});
