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

  it('concurrent saves never expose a torn file and the last call wins', async () => {
    const cache = new CapabilityCache(path);
    const mapFor = (i: number) => ({
      [`srv${i}`]: { tools: Array.from({ length: 200 }, (_, n) => ({ name: `t${n}` })), resources: [], prompts: [], fetchedAt: `${i}` },
    });
    await cache.save(mapFor(0));
    const saves: Promise<void>[] = [];
    for (let i = 1; i <= 30; i++) {
      saves.push(cache.save(mapFor(i)));
      expect(Object.keys(await cache.load())).toHaveLength(1);
    }
    await Promise.all(saves);
    expect(await cache.load()).toEqual(mapFor(30));
  });
});
