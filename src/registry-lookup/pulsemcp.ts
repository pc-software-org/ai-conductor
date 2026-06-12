import type { FetchLike, InstallInfo, RegistryCapabilities, RegistryEntry, RegistrySource } from './types.js';

interface PulseServer { name: string; short_description?: string; package_name?: string | null; remotes?: { url?: string }[]; }

export class PulseMcpRegistry implements RegistrySource {
  readonly id = 'pulsemcp';
  readonly title = 'PulseMCP';
  // Best-effort connect (when a package_name or remote is present); no secret schema.
  readonly capabilities: RegistryCapabilities = { canConnect: true, canDetectSecrets: false };

  constructor(
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly baseUrl = 'https://api.pulsemcp.com',
  ) {}

  async search(query: string, limit: number): Promise<RegistryEntry[]> {
    const url = `${this.baseUrl}/v0beta/servers?query=${encodeURIComponent(query)}&count_per_page=${limit}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`pulsemcp registry returned HTTP ${res.status}`);
    const body = (await res.json()) as { servers?: PulseServer[] };
    return (body.servers ?? []).map((s) => this.toEntry(s));
  }

  private toEntry(s: PulseServer): RegistryEntry {
    return {
      source: this.id,
      ref: `${this.id}:${s.name}`,
      name: s.name,
      description: s.short_description ?? '',
      install: this.installOf(s),
      requiredEnv: [],
    };
  }

  private installOf(s: PulseServer): InstallInfo | undefined {
    const remoteUrl = s.remotes?.[0]?.url;
    if (remoteUrl) return { type: 'http', url: remoteUrl };
    if (s.package_name) return { type: 'stdio', command: 'npx', args: ['-y', s.package_name], envNames: [] };
    return undefined;
  }
}
