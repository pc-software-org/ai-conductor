import type { EnvRequirement, FetchLike, InstallInfo, RegistryCapabilities, RegistryEntry, RegistrySource } from './types.js';

interface OfficialEnvVar { name: string; description?: string; isRequired?: boolean; isSecret?: boolean; }
interface OfficialPackage { registryType?: string; identifier?: string; runtimeHint?: string; environmentVariables?: OfficialEnvVar[]; }
interface OfficialRemote { type?: string; url?: string; }
interface OfficialServer { name: string; description?: string; remotes?: OfficialRemote[]; packages?: OfficialPackage[]; }

export class OfficialRegistry implements RegistrySource {
  readonly id = 'official';
  readonly title = 'Official MCP Registry';
  readonly capabilities: RegistryCapabilities = { canConnect: true, canDetectSecrets: true };

  constructor(
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly baseUrl = 'https://registry.modelcontextprotocol.io',
  ) {}

  async search(query: string, limit: number): Promise<RegistryEntry[]> {
    const url = `${this.baseUrl}/v0/servers?search=${encodeURIComponent(query)}&limit=${limit}`;
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`official registry returned HTTP ${res.status}`);
    const body = (await res.json()) as { servers?: { server: OfficialServer }[] };
    return (body.servers ?? []).map((s) => this.toEntry(s.server));
  }

  private toEntry(server: OfficialServer): RegistryEntry {
    return {
      source: this.id,
      ref: `${this.id}:${server.name}`,
      name: server.name,
      description: server.description ?? '',
      install: this.installOf(server),
      requiredEnv: this.envOf(server),
    };
  }

  // Prefer a remote (no child process); else the first npm package as stdio.
  private installOf(server: OfficialServer): InstallInfo | undefined {
    const remote = server.remotes?.[0];
    if (remote?.url) return { type: remote.type === 'sse' ? 'sse' : 'http', url: remote.url };
    const pkg = (server.packages ?? []).find((p) => p.registryType === 'npm') ?? server.packages?.[0];
    if (pkg?.identifier) {
      return {
        type: 'stdio',
        command: pkg.runtimeHint || 'npx',
        args: ['-y', pkg.identifier],
        envNames: (pkg.environmentVariables ?? []).map((e) => e.name),
      };
    }
    return undefined;
  }

  private envOf(server: OfficialServer): EnvRequirement[] {
    const pkg = (server.packages ?? []).find((p) => p.environmentVariables) ?? server.packages?.[0];
    return (pkg?.environmentVariables ?? []).map((e) => ({
      name: e.name,
      description: e.description,
      required: !!e.isRequired,
      secret: !!e.isSecret,
    }));
  }
}
