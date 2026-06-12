import type { EnvRequirement, FetchLike, RegistryCapabilities, RegistryEntry, RegistrySource } from './types.js';

interface GlamaEnvSchema { properties?: Record<string, { description?: string }>; required?: string[]; }
interface GlamaServer { id: string; name: string; description?: string; environmentVariablesJsonSchema?: GlamaEnvSchema; }

export class GlamaRegistry implements RegistrySource {
  readonly id = 'glama';
  readonly title = 'Glama';
  // Glama lists repository + an env schema but no runnable command and no isSecret flag,
  // so it is a discovery-only source (no auto-connect, no secret detection).
  readonly capabilities: RegistryCapabilities = { canConnect: false, canDetectSecrets: false };

  constructor(
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly baseUrl = 'https://glama.ai',
  ) {}

  async search(query: string, limit: number): Promise<RegistryEntry[]> {
    const url = `${this.baseUrl}/api/mcp/v1/servers?query=${encodeURIComponent(query)}&first=${limit}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`glama registry returned HTTP ${res.status}`);
    const body = (await res.json()) as { servers?: GlamaServer[] };
    return (body.servers ?? []).map((s) => this.toEntry(s));
  }

  private toEntry(s: GlamaServer): RegistryEntry {
    return {
      source: this.id,
      ref: `${this.id}:${s.id}`,
      name: s.name,
      description: s.description ?? '',
      install: undefined,
      requiredEnv: this.envOf(s.environmentVariablesJsonSchema),
    };
  }

  private envOf(schema?: GlamaEnvSchema): EnvRequirement[] {
    const required = new Set(schema?.required ?? []);
    return Object.entries(schema?.properties ?? {}).map(([name, p]) => ({
      name,
      description: p.description,
      required: required.has(name),
      secret: false, // Glama does not flag secrets
    }));
  }
}
