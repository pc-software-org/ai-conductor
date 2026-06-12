# MCP Registry Lookup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent discover MCP servers from registries (official by default; Glama/PulseMCP opt-in) and connect them — including keychain-secret guidance — via meta-tools.

**Architecture:** A `RegistrySource` interface with three adapters (`official`, `glama`, `pulsemcp`), each wrapping one HTTP API and normalizing results to a common `RegistryEntry`. A `RegistryAggregator` enumerates sources and fans search out to the selected ones (default `['official']`) with per-source timeout/error isolation. An `install` helper turns an entry into a `ServerDefinition` (wiring `${keychain:…}` for bound secrets) or returns guidance. Three new meta-tools (`list_registries`, `search_registry`, `install_from_registry`) expose this.

**Tech Stack:** TypeScript (ESM NodeNext → `.js` relative imports), Node global `fetch` (Node ≥ 20), Vitest. `gen:version` runs before build/test/typecheck.

**Reference spec:** `docs/superpowers/specs/2026-06-11-registry-lookup-design.md`

## Verified API facts (used for fixtures)

- **official** `GET https://registry.modelcontextprotocol.io/v0/servers?search=<q>&limit=<n>` → `{ servers: [{ server: { name, description, version, remotes?: [{type:'streamable-http'|'sse', url}], packages?: [{registryType, identifier, runtimeHint, transport, environmentVariables?: [{name, description?, isRequired?, isSecret?}]}] } }], metadata }`.
- **glama** `GET https://glama.ai/api/mcp/v1/servers?query=<q>&first=<n>` → `{ servers: [{ id, name, namespace, slug, description, repository?: {url}, environmentVariablesJsonSchema?: {properties:{[name]:{description?,type}}, required?: string[]}, attributes, url }], pageInfo }`. No run command, no `isSecret`.
- **pulsemcp** `GET https://api.pulsemcp.com/v0beta/servers?query=<q>&count_per_page=<n>` → `{ servers: [{ name, short_description, source_code_url, package_registry, package_name, remotes: [{url}] }], total_count, next }`. Often `package_name: null`; no env/secret info.

## Canonical interfaces (consistent across tasks)

```ts
// src/registry-lookup/types.ts
export type InstallInfo =
  | { type: 'stdio'; command: string; args: string[]; envNames: string[] }
  | { type: 'http' | 'sse'; url: string };

export interface EnvRequirement { name: string; description?: string; required: boolean; secret: boolean; }

export interface RegistryEntry {
  source: string;
  ref: string;          // "<source>:<name-or-id>", stable, resolvable
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

// src/registry-lookup/aggregate.ts
export interface RegistryInfo { id: string; title: string; canConnect: boolean; canDetectSecrets: boolean; }
export interface SearchOutcome { entries: RegistryEntry[]; errors: { source: string; error: string }[]; }
export class RegistryAggregator {
  constructor(sources: RegistrySource[], timeoutMs?: number);
  list(): RegistryInfo[];
  search(query: string, sourceIds?: string[], limit?: number): Promise<SearchOutcome>; // default ['official']
}

// src/registry-lookup/install.ts
export interface InstallRequest { id?: string; env?: Record<string, string>; secretBindings?: Record<string, string>; }
export interface InstallPlan { def?: unknown; guidance?: string; } // def is an unvalidated ServerDefinition object
export function buildServerDefinition(entry: RegistryEntry, req: InstallRequest): InstallPlan;
export function normalizeId(s: string): string;
```

`ref` scheme: official `official:<server.name>`, glama `glama:<id>`, pulsemcp `pulsemcp:<name>`.

---

### Task 1: types + Official adapter

**Files:**
- Create: `src/registry-lookup/types.ts`, `src/registry-lookup/official.ts`
- Test: `test/registry-official.test.ts`

- [ ] **Step 1: Write `src/registry-lookup/types.ts`** (exactly the interfaces block above — the `types.ts` portion: `InstallInfo`, `EnvRequirement`, `RegistryEntry`, `RegistryCapabilities`, `RegistrySource`, `FetchLike`).

- [ ] **Step 2: Write the failing test `test/registry-official.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { OfficialRegistry } from '../src/registry-lookup/official.js';
import type { FetchLike } from '../src/registry-lookup/types.js';

const BODY = {
  servers: [
    {
      server: {
        name: 'ac.inference.sh/mcp',
        description: 'Run 150+ AI apps.',
        version: '1.0.1',
        remotes: [{ type: 'streamable-http', url: 'https://sh.inference.ac' }],
      },
    },
    {
      server: {
        name: 'com.pulsemcp/remote-filesystem',
        description: 'Remote filesystem ops.',
        version: '0.1.2',
        packages: [
          {
            registryType: 'npm',
            identifier: 'remote-filesystem-mcp-server',
            runtimeHint: 'npx',
            transport: { type: 'stdio' },
            environmentVariables: [
              { name: 'GCS_BUCKET', description: 'bucket', isRequired: true },
              { name: 'GCS_PRIVATE_KEY', description: 'key', isRequired: true, isSecret: true },
              { name: 'GCS_PROJECT_ID', description: 'project' },
            ],
          },
        ],
      },
    },
  ],
  metadata: { count: 2 },
};

function fakeFetch(body: unknown): FetchLike {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

describe('OfficialRegistry', () => {
  it('maps a remote entry to an http install', async () => {
    const reg = new OfficialRegistry(fakeFetch(BODY));
    const entries = await reg.search('x', 10);
    const remote = entries.find((e) => e.name === 'ac.inference.sh/mcp')!;
    expect(remote.ref).toBe('official:ac.inference.sh/mcp');
    expect(remote.install).toEqual({ type: 'http', url: 'https://sh.inference.ac' });
    expect(remote.requiredEnv).toEqual([]);
  });

  it('maps a package entry to stdio + detects required + secret env', async () => {
    const reg = new OfficialRegistry(fakeFetch(BODY));
    const entries = await reg.search('x', 10);
    const pkg = entries.find((e) => e.name === 'com.pulsemcp/remote-filesystem')!;
    expect(pkg.install).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'remote-filesystem-mcp-server'],
      envNames: ['GCS_BUCKET', 'GCS_PRIVATE_KEY', 'GCS_PROJECT_ID'],
    });
    expect(pkg.requiredEnv).toContainEqual({ name: 'GCS_PRIVATE_KEY', description: 'key', required: true, secret: true });
    expect(pkg.requiredEnv).toContainEqual({ name: 'GCS_BUCKET', description: 'bucket', required: true, secret: false });
  });

  it('throws on a non-ok HTTP response', async () => {
    const reg = new OfficialRegistry(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(reg.search('x', 10)).rejects.toThrow(/503/);
  });

  it('reports full capabilities', () => {
    expect(new OfficialRegistry(fakeFetch(BODY)).capabilities).toEqual({ canConnect: true, canDetectSecrets: true });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run test/registry-official.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/registry-lookup/official.ts`**

```ts
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
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm vitest run test/registry-official.test.ts && pnpm typecheck`
Expected: PASS (4 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(registry-lookup): types + official MCP registry adapter"
```

---

### Task 2: Glama adapter

**Files:**
- Create: `src/registry-lookup/glama.ts`
- Test: `test/registry-glama.test.ts`

- [ ] **Step 1: Write the failing test `test/registry-glama.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { GlamaRegistry } from '../src/registry-lookup/glama.js';
import type { FetchLike } from '../src/registry-lookup/types.js';

const BODY = {
  servers: [
    {
      id: 'bac8fgtyyo',
      name: 'mcp-catalogue',
      namespace: 'Aidan-Kay',
      slug: 'mcp-catalogue',
      description: 'A browse-first MCP middleware.',
      repository: { url: 'https://github.com/Aidan-Kay/mcp-catalogue' },
      environmentVariablesJsonSchema: {
        type: 'object',
        properties: { MCP_CATALOGUE_AUTH_TOKEN: { description: 'Bearer token', type: 'string' } },
        required: ['MCP_CATALOGUE_AUTH_TOKEN'],
      },
    },
  ],
  pageInfo: { hasNextPage: true },
};

const fakeFetch = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => body });

describe('GlamaRegistry', () => {
  it('maps an entry: ref by id, env from JSON schema (no secret flag), no install', async () => {
    const reg = new GlamaRegistry(fakeFetch(BODY));
    const [e] = await reg.search('x', 10);
    expect(e.ref).toBe('glama:bac8fgtyyo');
    expect(e.name).toBe('mcp-catalogue');
    expect(e.install).toBeUndefined();
    expect(e.requiredEnv).toEqual([
      { name: 'MCP_CATALOGUE_AUTH_TOKEN', description: 'Bearer token', required: true, secret: false },
    ]);
  });

  it('reports discovery-only capabilities', () => {
    expect(new GlamaRegistry(fakeFetch(BODY)).capabilities).toEqual({ canConnect: false, canDetectSecrets: false });
  });

  it('throws on a non-ok response', async () => {
    const reg = new GlamaRegistry(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    await expect(reg.search('x', 10)).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/registry-glama.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/registry-lookup/glama.ts`**

```ts
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run test/registry-glama.test.ts && pnpm typecheck`
Expected: PASS (3 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(registry-lookup): Glama adapter (discovery-only)"
```

---

### Task 3: PulseMCP adapter

**Files:**
- Create: `src/registry-lookup/pulsemcp.ts`
- Test: `test/registry-pulsemcp.test.ts`

- [ ] **Step 1: Write the failing test `test/registry-pulsemcp.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { PulseMcpRegistry } from '../src/registry-lookup/pulsemcp.js';
import type { FetchLike } from '../src/registry-lookup/types.js';

const BODY = {
  servers: [
    { name: 'Filesystem', short_description: 'Secure FS ops.', package_name: null, remotes: [] },
    { name: 'Foo', short_description: 'A foo server.', package_name: 'foo-mcp-server', remotes: [] },
    { name: 'Bar', short_description: 'Remote bar.', package_name: null, remotes: [{ url: 'https://bar.example/mcp' }] },
  ],
  total_count: 3,
};

const fakeFetch = (body: unknown): FetchLike => async () => ({ ok: true, status: 200, json: async () => body });

describe('PulseMcpRegistry', () => {
  it('maps a package_name entry to stdio, a remote entry to http, and a bare entry to no install', async () => {
    const reg = new PulseMcpRegistry(fakeFetch(BODY));
    const entries = await reg.search('x', 10);
    const fs = entries.find((e) => e.name === 'Filesystem')!;
    const foo = entries.find((e) => e.name === 'Foo')!;
    const bar = entries.find((e) => e.name === 'Bar')!;
    expect(fs.install).toBeUndefined();
    expect(fs.ref).toBe('pulsemcp:Filesystem');
    expect(foo.install).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'foo-mcp-server'], envNames: [] });
    expect(bar.install).toEqual({ type: 'http', url: 'https://bar.example/mcp' });
    expect(fs.requiredEnv).toEqual([]);
  });

  it('reports best-effort connect, no secret detection', () => {
    expect(new PulseMcpRegistry(fakeFetch(BODY)).capabilities).toEqual({ canConnect: true, canDetectSecrets: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/registry-pulsemcp.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/registry-lookup/pulsemcp.ts`**

```ts
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run test/registry-pulsemcp.test.ts && pnpm typecheck`
Expected: PASS (2 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(registry-lookup): PulseMCP adapter (best-effort)"
```

---

### Task 4: RegistryAggregator

**Files:**
- Modify: `src/registry-lookup/aggregate.ts` (create)
- Test: `test/registry-aggregate.test.ts`

- [ ] **Step 1: Write the failing test `test/registry-aggregate.test.ts`**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/registry-aggregate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/registry-lookup/aggregate.ts`**

```ts
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
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run test/registry-aggregate.test.ts && pnpm typecheck`
Expected: PASS (4 tests), no type errors.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(registry-lookup): aggregator (default official, fan-out, error isolation)"
```

---

### Task 5: install — entry → ServerDefinition or guidance

**Files:**
- Create: `src/registry-lookup/install.ts`
- Test: `test/registry-install.test.ts`

- [ ] **Step 1: Write the failing test `test/registry-install.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { buildServerDefinition, normalizeId } from '../src/registry-lookup/install.js';
import type { RegistryEntry } from '../src/registry-lookup/types.js';

const stdioEntry = (requiredEnv: RegistryEntry['requiredEnv']): RegistryEntry => ({
  source: 'official', ref: 'official:x/fs', name: 'x/fs', description: '',
  install: { type: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], envNames: requiredEnv.map((e) => e.name) },
  requiredEnv,
});

describe('normalizeId', () => {
  it('strips disallowed chars (including the __ delimiter source) to hyphens', () => {
    expect(normalizeId('com.pulsemcp/remote_filesystem')).toBe('com-pulsemcp-remote-filesystem');
  });
});

describe('buildServerDefinition', () => {
  it('returns guidance when there is no install info', () => {
    const entry: RegistryEntry = { source: 'glama', ref: 'glama:y', name: 'y', description: '', requiredEnv: [] };
    const plan = buildServerDefinition(entry, {});
    expect(plan.def).toBeUndefined();
    expect(plan.guidance).toMatch(/no run details|add_server/i);
  });

  it('asks for secret bindings when a required secret is unbound', () => {
    const plan = buildServerDefinition(stdioEntry([{ name: 'GCS_PRIVATE_KEY', required: true, secret: true }]), {});
    expect(plan.def).toBeUndefined();
    expect(plan.guidance).toMatch(/GCS_PRIVATE_KEY/);
    expect(plan.guidance).toMatch(/secret set/);
  });

  it('wires bound secrets as ${keychain:...} env refs', () => {
    const plan = buildServerDefinition(
      stdioEntry([{ name: 'GCS_PRIVATE_KEY', required: true, secret: true }]),
      { id: 'fs', secretBindings: { GCS_PRIVATE_KEY: 'gcs-key' } },
    );
    expect(plan.guidance).toBeUndefined();
    expect(plan.def).toEqual({
      id: 'fs', enabled: true,
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'fs-mcp'], env: { GCS_PRIVATE_KEY: '${keychain:gcs-key}' } },
    });
  });

  it('asks for required non-secret env when not provided', () => {
    const plan = buildServerDefinition(stdioEntry([{ name: 'GCS_BUCKET', required: true, secret: false }]), { id: 'fs' });
    expect(plan.def).toBeUndefined();
    expect(plan.guidance).toMatch(/GCS_BUCKET/);
  });

  it('puts provided non-secret env into the definition', () => {
    const plan = buildServerDefinition(stdioEntry([{ name: 'GCS_BUCKET', required: true, secret: false }]), { id: 'fs', env: { GCS_BUCKET: 'my-bucket' } });
    expect(plan.def).toMatchObject({ transport: { env: { GCS_BUCKET: 'my-bucket' } } });
  });

  it('builds a remote (http) definition with no env handling', () => {
    const entry: RegistryEntry = {
      source: 'official', ref: 'official:r', name: 'r', description: '',
      install: { type: 'http', url: 'https://r.example/mcp' }, requiredEnv: [],
    };
    const plan = buildServerDefinition(entry, { id: 'r' });
    expect(plan.def).toEqual({ id: 'r', enabled: true, transport: { type: 'http', url: 'https://r.example/mcp' } });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/registry-install.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/registry-lookup/install.ts`**

```ts
import type { RegistryEntry } from './types.js';

export interface InstallRequest { id?: string; env?: Record<string, string>; secretBindings?: Record<string, string>; }
export interface InstallPlan { def?: unknown; guidance?: string; }

// Map a registry name to a valid server id (alphanumeric/hyphen, no underscores).
export function normalizeId(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'server';
}

export function buildServerDefinition(entry: RegistryEntry, req: InstallRequest): InstallPlan {
  if (!entry.install) {
    return {
      guidance: `'${entry.ref}' has no run details from source '${entry.source}'. Add it manually with add_server (provide command/args or a url).`,
    };
  }

  // Required secrets must be bound to a keychain name first.
  const unboundSecrets = entry.requiredEnv
    .filter((e) => e.required && e.secret)
    .filter((e) => !(req.secretBindings && e.name in req.secretBindings));
  if (unboundSecrets.length > 0) {
    const names = unboundSecrets.map((e) => e.name).join(', ');
    const example = unboundSecrets[0].name;
    return {
      guidance:
        `'${entry.ref}' needs secret(s): ${names}. Store each with 'mcp-proxy-conductor secret set <name>', ` +
        `then re-run install_from_registry with secretBindings, e.g. { "${example}": "<keychain-name>" }.`,
    };
  }

  // Required non-secret env must be provided as plain values.
  const missingEnv = entry.requiredEnv
    .filter((e) => e.required && !e.secret)
    .filter((e) => !(req.env && e.name in req.env));
  if (missingEnv.length > 0) {
    const names = missingEnv.map((e) => e.name).join(', ');
    return { guidance: `'${entry.ref}' needs env value(s): ${names}. Re-run install_from_registry with env: { "${missingEnv[0].name}": "<value>" }.` };
  }

  const id = normalizeId(req.id ?? entry.name);

  if (entry.install.type === 'stdio') {
    const env: Record<string, string> = { ...(req.env ?? {}) };
    for (const [envName, keychainName] of Object.entries(req.secretBindings ?? {})) {
      env[envName] = `\${keychain:${keychainName}}`;
    }
    const def: { id: string; enabled: boolean; transport: Record<string, unknown> } = {
      id,
      enabled: true,
      transport: { type: 'stdio', command: entry.install.command, args: entry.install.args },
    };
    if (Object.keys(env).length > 0) def.transport.env = env;
    else def.transport.env = {};
    return { def };
  }

  // Remote (http/sse): the registry schema does not give a header name for auth, so
  // env/secret binding is out of scope here — connect with the URL; header auth is a
  // manual add_server case.
  return { def: { id, enabled: true, transport: { type: entry.install.type, url: entry.install.url } } };
}
```

> Note: the stdio test expects `env` present (with the bound secret). For the remote test, no `env` key. The stdio "provided non-secret env" test expects `env: { GCS_BUCKET: 'my-bucket' }`. The empty-env stdio path sets `env: {}` — matches `ServerDefinitionSchema` defaults. Keep the explicit `env` on stdio defs for predictability.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run test/registry-install.test.ts && pnpm typecheck`
Expected: PASS (7 tests), no type errors.

> If the `stdioEntry([...secret...])` test's expected `def` includes `env` but the empty-env branch differs, align the implementation so a bound-secret stdio def has exactly `env: { GCS_PRIVATE_KEY: '${keychain:gcs-key}' }` (it does: `req.env` empty + one secret binding).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(registry-lookup): install planner (keychain bindings + guidance)"
```

---

### Task 6: Meta-tools — list_registries / search_registry / install_from_registry

**Files:**
- Modify: `src/meta/tools.ts`
- Test: `test/meta-registry.test.ts`

- [ ] **Step 1: Write the failing test `test/meta-registry.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MetaTools } from '../src/meta/tools.js';
import { DownstreamManager } from '../src/registry/manager.js';
import { ConfigStore } from '../src/config/store.js';
import { CapabilityCache } from '../src/config/capability-cache.js';
import { RegistryAggregator } from '../src/registry-lookup/aggregate.js';
import type { RegistrySource, RegistryEntry } from '../src/registry-lookup/types.js';
import { makeEchoServer } from './helpers/echoServer.js';

function source(id: string, entries: RegistryEntry[]): RegistrySource {
  return { id, title: id, capabilities: { canConnect: id === 'official', canDetectSecrets: id === 'official' }, search: async () => entries };
}

async function setup(entries: RegistryEntry[]) {
  const a = await makeEchoServer('A');
  const mgr = new DownstreamManager(async () => a.clientTransport, {
    cache: new CapabilityCache(join(mkdtempSync(join(tmpdir(), 'mr-')), 'c.json')),
  });
  const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'mr-')), 'cfg.json'));
  await store.save({ servers: [] });
  const agg = new RegistryAggregator([source('official', entries), source('glama', [])]);
  return { meta: new MetaTools(mgr, store, agg), mgr, store };
}

const installable: RegistryEntry = {
  source: 'official', ref: 'official:demo/echo', name: 'demo/echo', description: 'echo',
  install: { type: 'stdio', command: 'npx', args: ['-y', 'echo-mcp'], envNames: [] }, requiredEnv: [],
};

describe('registry meta-tools', () => {
  it('list_registries returns sources with capability flags', async () => {
    const { meta } = await setup([]);
    const res = await meta.call('list_registries', {});
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed.find((r: any) => r.id === 'official')).toMatchObject({ canConnect: true, canDetectSecrets: true });
  });

  it('search_registry defaults to official and returns refs', async () => {
    const { meta } = await setup([installable]);
    const res = await meta.call('search_registry', { query: 'echo' });
    expect((res.content[0] as { text: string }).text).toContain('official:demo/echo');
  });

  it('install_from_registry connects an installable entry and persists it', async () => {
    const { meta, mgr, store } = await setup([installable]);
    await meta.call('search_registry', { query: 'echo' }); // populates ref cache
    const res = await meta.call('install_from_registry', { ref: 'official:demo/echo', id: 'echo' });
    expect(res.isError).toBeFalsy();
    expect(mgr.get('echo')?.state).toBe('connected');
    expect((await store.load()).servers.map((s) => s.id)).toContain('echo');
  });

  it('install_from_registry returns guidance for an unknown ref', async () => {
    const { meta } = await setup([installable]);
    const res = await meta.call('install_from_registry', { ref: 'official:does-not-exist' });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/meta-registry.test.ts`
Expected: FAIL — `MetaTools` does not accept an aggregator / new tools missing.

- [ ] **Step 3: Edit `src/meta/tools.ts`**

Add imports at the top:

```ts
import { ServerDefinitionSchema } from '../config/schema.js';
import type { RegistryAggregator } from '../registry-lookup/aggregate.js';
import type { RegistryEntry } from '../registry-lookup/types.js';
import { buildServerDefinition } from '../registry-lookup/install.js';
```

(Keep the existing `ServerDefinitionSchema` import — do not duplicate.)

Change the constructor and add a ref cache:

```ts
export class MetaTools {
  private readonly lastEntries = new Map<string, RegistryEntry>();

  constructor(
    private readonly manager: DownstreamManager,
    private readonly store: ConfigStore,
    private readonly registry?: RegistryAggregator,
  ) {}
```

Add the three definitions to the array returned by `definitions()` (after `list_servers`):

```ts
      {
        name: 'list_registries',
        description: 'List available MCP registries to search, with capability flags (canConnect, canDetectSecrets).',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'search_registry',
        description: 'Search MCP registries for servers. Defaults to the official registry; pass sources (from list_registries) to include others.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' }, description: 'Registry ids to search; default ["official"]' },
            limit: { type: 'number', description: 'Max results per source (default 10)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'install_from_registry',
        description: 'Install a server found via search_registry by its ref. Provide secretBindings { ENV_NAME: keychain-name } for required secrets, and env { ENV_NAME: value } for required non-secret env.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'The ref from a search_registry result' },
            id: { type: 'string', description: 'Optional downstream id (defaults to a normalized name)' },
            env: { type: 'object' },
            secretBindings: { type: 'object' },
          },
          required: ['ref'],
        },
      },
```

Extend `has()`:

```ts
  has(name: string): boolean {
    return ['add_server', 'remove_server', 'list_servers', 'list_registries', 'search_registry', 'install_from_registry'].includes(name);
  }
```

Add routes in `call()` (before the `unknown meta-tool` fallback):

```ts
      if (name === 'list_registries') return this.listRegistries();
      if (name === 'search_registry') return await this.searchRegistry(args);
      if (name === 'install_from_registry') return await this.installFromRegistry(args);
```

Refactor the persist+add logic out of `addServer` into a shared helper and add the registry methods:

```ts
  private async persistAndAdd(def: ReturnType<typeof ServerDefinitionSchema.parse>): Promise<void> {
    await this.manager.add(def);
    const config = await this.store.load();
    config.servers = [...config.servers.filter((s) => s.id !== def.id), def];
    await this.store.save(config);
  }

  private listRegistries(): ToolResult {
    if (!this.registry) return fail('registry lookup is not configured');
    return ok(JSON.stringify(this.registry.list(), null, 2));
  }

  private async searchRegistry(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.registry) return fail('registry lookup is not configured');
    const query = String(args.query ?? '');
    if (!query) return fail('query is required');
    const sources = Array.isArray(args.sources) ? (args.sources as string[]) : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    const outcome = await this.registry.search(query, sources, limit);
    for (const e of outcome.entries) this.lastEntries.set(e.ref, e);
    const view = outcome.entries.map((e) => ({
      ref: e.ref,
      source: e.source,
      name: e.name,
      description: e.description,
      connectable: e.install !== undefined,
      requiredSecrets: e.requiredEnv.filter((v) => v.secret).map((v) => v.name),
    }));
    const payload: Record<string, unknown> = { results: view };
    if (outcome.errors.length > 0) payload.errors = outcome.errors;
    return ok(JSON.stringify(payload, null, 2));
  }

  private async installFromRegistry(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.registry) return fail('registry lookup is not configured');
    const ref = String(args.ref ?? '');
    const entry = this.lastEntries.get(ref);
    if (!entry) return fail(`unknown ref '${ref}'. Run search_registry first and use a ref from its results.`);
    const plan = buildServerDefinition(entry, {
      id: args.id ? String(args.id) : undefined,
      env: (args.env as Record<string, string>) ?? undefined,
      secretBindings: (args.secretBindings as Record<string, string>) ?? undefined,
    });
    if (!plan.def) return ok(plan.guidance ?? 'cannot install this entry automatically.');
    const def = ServerDefinitionSchema.parse(plan.def);
    if (this.manager.get(def.id)) return fail(`server '${def.id}' already exists`);
    await this.persistAndAdd(def);
    return ok(`installed '${def.id}' from ${entry.source} (state: ${this.manager.get(def.id)?.state}).`);
  }
```

Update the existing `addServer` to use the shared helper:

```ts
  private async addServer(args: Record<string, unknown>): Promise<ToolResult> {
    const def = ServerDefinitionSchema.parse({ id: args.id, transport: args.transport, enabled: true });
    await this.persistAndAdd(def);
    return ok(`server '${def.id}' added (state: ${this.manager.get(def.id)?.state}).`);
  }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run test/meta-registry.test.ts test/meta.test.ts && pnpm typecheck`
Expected: PASS (new registry meta tests + the existing meta tests still green).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(meta): list_registries / search_registry / install_from_registry"
```

---

### Task 7: Wire the aggregator into the entry point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Edit `src/index.ts`**

Add imports (after the existing registry-lookup-free imports):

```ts
import { RegistryAggregator } from './registry-lookup/aggregate.js';
import { OfficialRegistry } from './registry-lookup/official.js';
import { GlamaRegistry } from './registry-lookup/glama.js';
import { PulseMcpRegistry } from './registry-lookup/pulsemcp.js';
```

Add an optional override to `ConductorOptions`:

```ts
  registry?: RegistryAggregator;
```

In `createConductor`, build the aggregator and pass it to `MetaTools`. Find:

```ts
  const meta = new MetaTools(manager, store);
```

and replace with:

```ts
  const registry =
    opts.registry ?? new RegistryAggregator([new OfficialRegistry(), new GlamaRegistry(), new PulseMcpRegistry()]);
  const meta = new MetaTools(manager, store, registry);
```

- [ ] **Step 2: Full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all tests pass, no type errors, `dist/index.js` built with shebang. (The default adapters use the global `fetch` but are never called during tests — tests inject a stub aggregator or don't exercise registry tools.)

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: wire registry aggregator (official+glama+pulsemcp) into entry point"
```

---

### Task 8: Manual verification + README + release 0.3.0

**Files:** Modify `README.md`; operational release.

- [ ] **Step 1: Manual smoke against live registries**

```bash
pnpm build
```
Run a scripted MCP session against `node dist/index.js` (initialize, then `tools/call`):
- `list_registries` → shows official/glama/pulsemcp with capability flags.
- `search_registry` with `{ "query": "filesystem" }` → official results with refs.
- `search_registry` with `{ "query": "filesystem", "sources": ["official","glama","pulsemcp"] }` → results from all three (or per-source errors surfaced, not a crash).
Document the observed output. (Network-dependent; if a source is down, confirm the others still return and the error is reported.)

- [ ] **Step 2: Update `README.md`**

Add a **Discovering servers** section after "Managing downstream servers":
- `list_registries` — enumerate sources (official default; Glama/PulseMCP are discovery-focused).
- `search_registry(query, sources?)` — defaults to the official registry; pass `sources` to widen.
- `install_from_registry(ref, { id?, env?, secretBindings? })` — installs a result; for entries needing secrets, store them with `secret set` and pass `secretBindings`.
- Note the capability asymmetry: auto-connect + secret detection is reliable for the official registry; Glama/PulseMCP are best-effort discovery.
Remove "MCP registry lookup" from the "planned, not yet implemented" list (now done).

- [ ] **Step 3: Bump + release**

```bash
npm version 0.3.0 --no-git-tag-version
git add -A && git commit -m "chore(release): 0.3.0"
git push
git tag v0.3.0 && git push origin v0.3.0
```
(Tag-triggered workflow publishes `mcp-proxy-conductor@0.3.0`.) Watch:
```bash
gh run watch "$(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

- [ ] **Step 4: Update the global install**

```bash
npm i -g mcp-proxy-conductor@0.3.0
```

---

## Self-review notes (author)

- **Spec coverage:** pluggable `RegistrySource` + normalized `RegistryEntry` (Task 1) · three adapters with verified mappings incl. secret detection for official, discovery-only for glama, best-effort for pulsemcp (Tasks 1-3) · aggregator: enumerate, default `['official']`, selection, per-source timeout + error isolation, unknown-source error (Task 4) · install planner with keychain `${keychain:}` bindings + guidance for missing install/secret/env (Task 5) · meta-tools `list_registries`/`search_registry`/`install_from_registry` with ref cache (Task 6) · entry wiring with global fetch (Task 7) · README + release (Task 8). All spec sections map to tasks.
- **Scope note (minor deviation, documented):** remote (http/sse) entries do not auto-wire header-based auth from the registry schema (the schema's per-remote header variables are not consumed); such servers connect by URL and header auth is a manual `add_server` case. Stdio env/secret binding is fully handled. This keeps the install planner bounded; noted in `install.ts` and the README.
- **Type consistency:** `RegistrySource`/`RegistryEntry`/`InstallInfo`/`EnvRequirement`/`RegistryCapabilities`/`FetchLike` (Task 1) used by all adapters; `RegistryAggregator.list()/search()` + `RegistryInfo`/`SearchOutcome` (Task 4); `buildServerDefinition`/`normalizeId`/`InstallRequest`/`InstallPlan` (Task 5); `MetaTools(manager, store, registry?)` + ref cache (Task 6); all consistent.
- **Back-compat:** `MetaTools`'s third constructor arg is optional, so existing `new MetaTools(manager, store)` call sites and tests keep compiling; registry tools return a clear "not configured" error when no aggregator is wired.
```
