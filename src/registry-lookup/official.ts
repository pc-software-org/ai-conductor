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

  // Prefer a remote (no child process); else the first npm package as stdio. install and
  // requiredEnv are derived from the SAME chosen package so they never describe different
  // packages. requiredEnv is only populated for a stdio install (a remote's auth is not
  // described by package env vars).
  private toEntry(server: OfficialServer): RegistryEntry {
    const remote = server.remotes?.[0];
    const pkg = (server.packages ?? []).find((p) => p.registryType === 'npm') ?? server.packages?.[0];

    let install: InstallInfo | undefined;
    let requiredEnv: EnvRequirement[] = [];
    if (remote?.url) {
      install = { type: remote.type === 'sse' ? 'sse' : 'http', url: remote.url };
    } else if (pkg?.identifier) {
      install = {
        type: 'stdio',
        command: pkg.runtimeHint || 'npx',
        args: ['-y', pkg.identifier],
        envNames: (pkg.environmentVariables ?? []).map((e) => e.name),
      };
      requiredEnv = (pkg.environmentVariables ?? []).map((e) => ({
        name: e.name,
        description: e.description,
        required: !!e.isRequired,
        secret: !!e.isSecret,
      }));
    }

    return {
      source: this.id,
      ref: `${this.id}:${server.name}`,
      name: server.name,
      description: server.description ?? '',
      install,
      requiredEnv,
    };
  }
}
