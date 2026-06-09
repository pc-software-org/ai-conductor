import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import envPaths from 'env-paths';
import { ConfigSchema, type Config } from './schema.js';

export function defaultConfigPath(): string {
  return `${envPaths('ai-conductor', { suffix: '' }).config}/config.json`;
}

export class ConfigStore {
  constructor(private readonly path: string = defaultConfigPath()) {}

  async load(): Promise<Config> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ConfigSchema.parse({});
      throw err;
    }
    return ConfigSchema.parse(JSON.parse(raw));
  }

  async save(config: Config): Promise<void> {
    const validated = ConfigSchema.parse(config);
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(validated, null, 2), 'utf8');
  }
}
