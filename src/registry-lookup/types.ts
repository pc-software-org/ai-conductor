export type InstallInfo =
  | { type: 'stdio'; command: string; args: string[]; envNames: string[] }
  | { type: 'http' | 'sse'; url: string };

export interface EnvRequirement { name: string; description?: string; required: boolean; secret: boolean; }

export interface RegistryEntry {
  source: string;
  ref: string; // "<source>:<name-or-id>", stable, resolvable
  name: string;
  description: string;
  install?: InstallInfo; // absent when the source gives no run details
  requiredEnv: EnvRequirement[];
}

export interface RegistryCapabilities { canConnect: boolean; canDetectSecrets: boolean; }

export interface RegistrySource {
  readonly id: string;
  readonly title: string;
  readonly capabilities: RegistryCapabilities;
  search(query: string, limit: number): Promise<RegistryEntry[]>;
}

// Minimal fetch shape so adapters are testable with a fake (Node global fetch satisfies it).
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
