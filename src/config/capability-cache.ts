import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import envPaths from 'env-paths';
import { z } from 'zod';

const CachedCapabilitiesSchema = z.object({
  tools: z.array(z.any()),
  resources: z.array(z.any()),
  prompts: z.array(z.any()),
  fetchedAt: z.string(),
});
const CacheMapSchema = z.record(z.string(), CachedCapabilitiesSchema);

export type CapabilityCacheMap = z.infer<typeof CacheMapSchema>;

export function defaultCapabilityCachePath(): string {
  return `${envPaths('ai-conductor', { suffix: '' }).config}/capabilities.json`;
}

// Derived, disposable cache of downstream capabilities. config.json stays the source of
// truth for definitions; this only lets us advertise tools/resources/prompts without
// connecting. A missing or corrupt file is treated as empty — never fatal.
export class CapabilityCache {
  constructor(private readonly path: string = defaultCapabilityCachePath()) {}

  async load(): Promise<CapabilityCacheMap> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    const parsed = CacheMapSchema.safeParse(JSON.parse(tryJson(raw)));
    return parsed.success ? parsed.data : {};
  }

  // Saves are serialized (last call wins) and atomic (tmp file + rename), so concurrent
  // callers can neither interleave writes nor let a load() see a half-written file.
  save(map: CapabilityCacheMap): Promise<void> {
    const data = JSON.stringify(map, null, 2); // snapshot now: callers mutate their map
    const run = this.pending.then(() => this.write(data));
    this.pending = run.catch(() => undefined);
    return run;
  }

  private pending: Promise<void> = Promise.resolve();

  private async write(data: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, this.path);
  }
}

function tryJson(raw: string): string {
  // JSON.parse throws on corrupt input; funnel that into safeParse-as-empty by returning
  // a benign value the schema rejects.
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return 'null';
  }
}
