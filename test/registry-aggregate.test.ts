import { describe, it, expect } from 'vitest';
import { RegistryAggregator } from '../src/registry-lookup/aggregate.js';
import type { RegistryEntry, RegistrySource } from '../src/registry-lookup/types.js';

function source(id: string, entries: RegistryEntry[], opts: { throws?: boolean } = {}): RegistrySource {
  return {
    id,
    title: id.toUpperCase(),
    capabilities: { canConnect: id === 'official', canDetectSecrets: id === 'official' },
    search: async () => {
      if (opts.throws) throw new Error(`${id} boom`);
      return entries;
    },
  };
}

const entry = (source: string, name: string): RegistryEntry => ({
  source, ref: `${source}:${name}`, name, description: '', requiredEnv: [],
});

describe('RegistryAggregator', () => {
  it('list() reports each source with capabilities', () => {
    const agg = new RegistryAggregator([source('official', []), source('glama', [])]);
    expect(agg.list()).toEqual([
      { id: 'official', title: 'OFFICIAL', canConnect: true, canDetectSecrets: true },
      { id: 'glama', title: 'GLAMA', canConnect: false, canDetectSecrets: false },
    ]);
  });

  it('searches only the official source by default', async () => {
    const agg = new RegistryAggregator([source('official', [entry('official', 'a')]), source('glama', [entry('glama', 'b')])]);
    const out = await agg.search('q');
    expect(out.entries.map((e) => e.ref)).toEqual(['official:a']);
    expect(out.errors).toEqual([]);
  });

  it('searches selected sources and isolates a failing one', async () => {
    const agg = new RegistryAggregator([
      source('official', [entry('official', 'a')]),
      source('glama', [], { throws: true }),
    ]);
    const out = await agg.search('q', ['official', 'glama']);
    expect(out.entries.map((e) => e.ref)).toEqual(['official:a']);
    expect(out.errors).toEqual([{ source: 'glama', error: 'glama boom' }]);
  });

  it('throws on an unknown source id', async () => {
    const agg = new RegistryAggregator([source('official', [])]);
    await expect(agg.search('q', ['nope'])).rejects.toThrow(/nope/);
  });
});
