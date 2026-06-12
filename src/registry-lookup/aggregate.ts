import type { RegistryEntry, RegistrySource } from './types.js';

export interface RegistryInfo { id: string; title: string; canConnect: boolean; canDetectSecrets: boolean; }
export interface SearchOutcome { entries: RegistryEntry[]; errors: { source: string; error: string }[]; }

export class RegistryAggregator {
  private readonly sources: Map<string, RegistrySource>;

  constructor(sources: RegistrySource[], private readonly timeoutMs = 8000) {
    this.sources = new Map(sources.map((s) => [s.id, s]));
  }

  list(): RegistryInfo[] {
    return [...this.sources.values()].map((s) => ({
      id: s.id,
      title: s.title,
      canConnect: s.capabilities.canConnect,
      canDetectSecrets: s.capabilities.canDetectSecrets,
    }));
  }

  async search(query: string, sourceIds: string[] = ['official'], limit = 10): Promise<SearchOutcome> {
    for (const id of sourceIds) {
      if (!this.sources.has(id)) throw new Error(`unknown registry '${id}' (call list_registries to see available sources)`);
    }
    const results = await Promise.all(
      sourceIds.map(async (id) => {
        const src = this.sources.get(id)!;
        try {
          const entries = await this.withTimeout(src.search(query, limit), id);
          return { entries, error: undefined as undefined | { source: string; error: string } };
        } catch (err) {
          return { entries: [] as RegistryEntry[], error: { source: id, error: err instanceof Error ? err.message : String(err) } };
        }
      }),
    );
    return {
      entries: results.flatMap((r) => r.entries),
      errors: results.flatMap((r) => (r.error ? [r.error] : [])),
    };
  }

  private withTimeout(p: Promise<RegistryEntry[]>, id: string): Promise<RegistryEntry[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${id} timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      timer.unref?.();
      p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
    });
  }
}
