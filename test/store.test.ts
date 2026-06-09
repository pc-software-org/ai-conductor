import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/config/store.js';

describe('ConfigStore', () => {
  let path: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'aicfg-'));
    path = join(dir, 'config.json');
  });

  it('returns empty config when file is missing', async () => {
    const store = new ConfigStore(path);
    expect(await store.load()).toEqual({ servers: [] });
  });

  it('round-trips a saved config', async () => {
    const store = new ConfigStore(path);
    const cfg = { servers: [{ id: 'a', enabled: true, transport: { type: 'stdio' as const, command: 'x', args: [], env: {} } }] };
    await store.save(cfg);
    expect(await new ConfigStore(path).load()).toEqual(cfg);
  });

  it('rejects a corrupt/invalid config file', async () => {
    const store = new ConfigStore(path);
    await store.save({ servers: [] });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{ not json');
    await expect(store.load()).rejects.toThrow();
  });
});
