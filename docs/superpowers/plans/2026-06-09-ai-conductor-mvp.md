# ai-conductor MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local MCP proxy that registers once with Claude (stdio) and aggregates multiple downstream MCP servers, manageable at runtime via meta-tools, with persistence.

**Architecture:** One Node process, two roles. Upstream: a low-level `Server` over stdio facing Claude. Downstream: one `Client` per managed server (stdio / Streamable HTTP / SSE). Capabilities (tools/resources/prompts) are aggregated with deterministic namespacing; calls route back to the owning downstream. Runtime management happens through meta-tools that mutate a persisted JSON store.

**Tech Stack:** TypeScript, Node ≥ 20, `@modelcontextprotocol/sdk@1.29.0`, `zod`, `env-paths`. Build: `tsup`. Tests: `vitest`. Package manager: `pnpm`. Distribution: npm package, run via `npx ai-conductor`.

---

## Verified SDK facts (1.29.0)

Import paths (ESM, `"type": "module"`):
- `import { Server } from '@modelcontextprotocol/sdk/server/index.js'`
- `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'`
- `import { Client } from '@modelcontextprotocol/sdk/client/index.js'`
- `import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'`
- `import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'`
- `import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'`
- `import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'`
- Request/notification schemas from `@modelcontextprotocol/sdk/types.js`:
  `ListToolsRequestSchema`, `CallToolRequestSchema`, `ListResourcesRequestSchema`,
  `ReadResourceRequestSchema`, `ListPromptsRequestSchema`, `GetPromptRequestSchema`,
  `ToolListChangedNotificationSchema`, `ResourceListChangedNotificationSchema`,
  `PromptListChangedNotificationSchema`.

`Client` methods used: `connect`, `close`, `listTools`, `callTool`, `listResources`,
`readResource`, `listPrompts`, `getPrompt`, `getServerCapabilities`, `setNotificationHandler`.
`Server` methods used: `setRequestHandler`, `connect`, `sendToolListChanged`,
`sendResourceListChanged`, `sendPromptListChanged`.

## File structure

```
src/
  index.ts                 # entry + shebang bin: wire everything, connect stdio
  types.ts                 # shared TS types (ServerInfo, ConnState)
  config/schema.ts         # zod: ServerDefinition, Config
  config/store.ts          # persisted JSON store (env-paths) load/save
  secrets/provider.ts      # SecretProvider interface + EnvSecretProvider
  registry/transport.ts    # buildTransport(def, secrets)
  registry/connection.ts   # DownstreamConnection (Client + transport + caps + state)
  registry/manager.ts      # DownstreamManager (Map<id, connection>, lifecycle)
  aggregator/namespace.ts  # encode/decode names + resource URIs
  aggregator/aggregate.ts  # Aggregator: merge + route
  meta/tools.ts            # meta-tools: add_server/remove_server/list_server(s)
  server/upstream.ts       # buildUpstreamServer(aggregator, meta) -> Server
test/
  *.test.ts                # one per unit + one end-to-end
  helpers/echoServer.ts    # in-memory downstream test double
```

---

### Task 1: Project scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `src/index.ts` (stub)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "ai-conductor",
  "version": "0.1.0",
  "description": "Local MCP proxy that aggregates downstream MCP servers, managed at runtime.",
  "type": "module",
  "bin": { "ai-conductor": "dist/index.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "env-paths": "^3.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsup": "^8.3.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "verbatimModuleSyntax": false
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
});
```

- [ ] **Step 5: Create `src/index.ts` stub**

```ts
export const VERSION = '0.1.0';
```

- [ ] **Step 6: Install and verify**

Run: `pnpm install && pnpm typecheck`
Expected: installs cleanly, no type errors.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "chore: scaffold ai-conductor (pnpm, tsup, vitest, tsconfig)"
```

---

### Task 2: Config schema

**Files:**
- Create: `src/config/schema.ts`
- Test: `test/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { ServerDefinitionSchema, ConfigSchema } from '../src/config/schema.js';

describe('ServerDefinitionSchema', () => {
  it('accepts a valid stdio definition and applies defaults', () => {
    const def = ServerDefinitionSchema.parse({
      id: 'github',
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'] },
    });
    expect(def.enabled).toBe(true);
    expect(def.transport).toMatchObject({ type: 'stdio', env: {} });
  });

  it('rejects ids containing underscores (namespacing safety)', () => {
    expect(() =>
      ServerDefinitionSchema.parse({ id: 'gh__x', transport: { type: 'stdio', command: 'x' } }),
    ).toThrow();
  });

  it('accepts http and sse definitions', () => {
    expect(ServerDefinitionSchema.parse({ id: 'a', transport: { type: 'http', url: 'https://x/mcp' } }).transport.type).toBe('http');
    expect(ServerDefinitionSchema.parse({ id: 'b', transport: { type: 'sse', url: 'https://x/sse' } }).transport.type).toBe('sse');
  });

  it('ConfigSchema defaults servers to []', () => {
    expect(ConfigSchema.parse({})).toEqual({ servers: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/schema.test.ts`
Expected: FAIL — cannot resolve `../src/config/schema.js`.

- [ ] **Step 3: Write `src/config/schema.ts`**

```ts
import { z } from 'zod';

// serverId: starts alphanumeric, then alphanumerics/hyphens. No underscores → can never
// contain the '__' namespacing delimiter.
const ServerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'id must be alphanumeric/hyphen, no underscores');

const StdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
});

const HttpTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
});

const SseTransportSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
});

export const TransportSchema = z.discriminatedUnion('type', [
  StdioTransportSchema,
  HttpTransportSchema,
  SseTransportSchema,
]);

export const ServerDefinitionSchema = z.object({
  id: ServerIdSchema,
  enabled: z.boolean().default(true),
  transport: TransportSchema,
});

export const ConfigSchema = z.object({
  servers: z.array(ServerDefinitionSchema).default([]),
});

export type ServerDefinition = z.infer<typeof ServerDefinitionSchema>;
export type Config = z.infer<typeof ConfigSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/schema.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(config): zod schema for server definitions and config"
```

---

### Task 3: SecretProvider

**Files:**
- Create: `src/secrets/provider.ts`
- Test: `test/secrets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { EnvSecretProvider } from '../src/secrets/provider.js';

describe('EnvSecretProvider', () => {
  const sp = new EnvSecretProvider({ MY_TOKEN: 'sekret' });

  it('returns literal values unchanged', async () => {
    expect(await sp.resolve('plain-value')).toBe('plain-value');
  });

  it('expands ${VAR} references from the env map', async () => {
    expect(await sp.resolve('Bearer ${MY_TOKEN}')).toBe('Bearer sekret');
  });

  it('throws on unknown ${VAR}', async () => {
    await expect(sp.resolve('${NOPE}')).rejects.toThrow(/NOPE/);
  });

  it('resolveRecord expands every value', async () => {
    expect(await sp.resolveRecord({ A: '${MY_TOKEN}', B: 'lit' })).toEqual({ A: 'sekret', B: 'lit' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/secrets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/secrets/provider.ts`**

```ts
// SecretProvider abstracts where secret values come from. MVP: expand ${VAR} from a
// supplied env map (defaults to process.env). A future KeychainSecretProvider can
// implement the same interface without changing call sites.
export interface SecretProvider {
  resolve(value: string): Promise<string>;
  resolveRecord(record: Record<string, string>): Promise<Record<string, string>>;
}

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  async resolve(value: string): Promise<string> {
    return value.replace(REF, (_, name: string) => {
      const v = this.env[name];
      if (v === undefined) throw new Error(`Secret reference \${${name}} is not set in the environment`);
      return v;
    });
  }

  async resolveRecord(record: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(record)) out[k] = await this.resolve(v);
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/secrets.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(secrets): SecretProvider interface with env-expanding default"
```

---

### Task 4: Config store

**Files:**
- Create: `src/config/store.ts`
- Test: `test/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigStore } from '../src/config/store.js';

describe('ConfigStore', () => {
  let path: string;
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'aicfg-'));
    path = join(dir, 'config.json');
  });

  it('returns empty config when file is missing', async () => {
    const store = new ConfigStore(path);
    expect(await store.load()).toEqual({ servers: [] });
  });

  it('round-trips a saved config', async () => {
    const store = new ConfigStore(path);
    const cfg = { servers: [{ id: 'a', enabled: true, transport: { type: 'stdio' as const, command: 'x', args: [], env: {} } }] };
    await store.save(cfg);
    expect(await new ConfigStore(path).load()).toEqual(cfg);
  });

  it('rejects a corrupt/invalid config file', async () => {
    const store = new ConfigStore(path);
    await store.save({ servers: [] });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, '{ not json');
    await expect(store.load()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/config/store.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(config): persisted JSON store with env-paths location"
```

---

### Task 5: Namespacing

**Files:**
- Create: `src/aggregator/namespace.ts`
- Test: `test/namespace.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { encodeName, decodeName, encodeUri, decodeUri } from '../src/aggregator/namespace.js';

describe('name namespacing', () => {
  it('round-trips a simple name', () => {
    expect(decodeName(encodeName('github', 'create_issue'))).toEqual({ serverId: 'github', name: 'create_issue' });
  });

  it('preserves original names that themselves contain the delimiter', () => {
    const q = encodeName('srv', 'weird__tool');
    expect(decodeName(q)).toEqual({ serverId: 'srv', name: 'weird__tool' });
  });

  it('throws when there is no delimiter (a meta-tool name)', () => {
    expect(() => decodeName('add_server')).toThrow();
  });
});

describe('uri namespacing', () => {
  it('round-trips an arbitrary resource uri', () => {
    const q = encodeUri('files', 'file:///etc/hosts?x=1');
    expect(decodeUri(q)).toEqual({ serverId: 'files', uri: 'file:///etc/hosts?x=1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/namespace.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/aggregator/namespace.ts`**

```ts
export const DELIM = '__';

export function encodeName(serverId: string, name: string): string {
  return `${serverId}${DELIM}${name}`;
}

// Split on the FIRST delimiter. serverId never contains '__' (enforced by schema),
// so everything after the first delimiter is the original name verbatim.
export function decodeName(qualified: string): { serverId: string; name: string } {
  const idx = qualified.indexOf(DELIM);
  if (idx === -1) throw new Error(`Not a namespaced name: ${qualified}`);
  return { serverId: qualified.slice(0, idx), name: qualified.slice(idx + DELIM.length) };
}

// Resources are keyed by opaque URI, so we wrap the original URI inside a conductor URI
// that carries the serverId. Stateless and collision-free across servers.
export function encodeUri(serverId: string, uri: string): string {
  const u = new URL('conductor://route/');
  u.searchParams.set('s', serverId);
  u.searchParams.set('u', uri);
  return u.toString();
}

export function decodeUri(qualified: string): { serverId: string; uri: string } {
  const u = new URL(qualified);
  const s = u.searchParams.get('s');
  const orig = u.searchParams.get('u');
  if (!s || orig === null) throw new Error(`Not a namespaced uri: ${qualified}`);
  return { serverId: s, uri: orig };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/namespace.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(aggregator): deterministic name and uri namespacing"
```

---

### Task 6: Transport factory

**Files:**
- Create: `src/registry/transport.ts`
- Test: `test/transport.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildTransport } from '../src/registry/transport.js';
import { EnvSecretProvider } from '../src/secrets/provider.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const sp = new EnvSecretProvider({ TOK: 'abc' });

describe('buildTransport', () => {
  it('builds a stdio transport with resolved env', async () => {
    const t = await buildTransport(
      { id: 'a', enabled: true, transport: { type: 'stdio', command: 'echo', args: ['hi'], env: { K: '${TOK}' } } },
      sp,
    );
    expect(t).toBeInstanceOf(StdioClientTransport);
  });

  it('builds an http transport', async () => {
    const t = await buildTransport(
      { id: 'b', enabled: true, transport: { type: 'http', url: 'https://x/mcp', headers: { Authorization: 'Bearer ${TOK}' } } },
      sp,
    );
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('builds an sse transport', async () => {
    const t = await buildTransport(
      { id: 'c', enabled: true, transport: { type: 'sse', url: 'https://x/sse', headers: {} } },
      sp,
    );
    expect(t).toBeInstanceOf(SSEClientTransport);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/transport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/registry/transport.ts`**

```ts
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ServerDefinition } from '../config/schema.js';
import type { SecretProvider } from '../secrets/provider.js';

export async function buildTransport(def: ServerDefinition, secrets: SecretProvider): Promise<Transport> {
  const t = def.transport;
  if (t.type === 'stdio') {
    const env = await secrets.resolveRecord(t.env);
    return new StdioClientTransport({ command: t.command, args: t.args, env: { ...getDefaultEnvironment(), ...env } });
  }
  const headers = await secrets.resolveRecord(t.headers);
  const requestInit = { headers };
  if (t.type === 'http') return new StreamableHTTPClientTransport(new URL(t.url), { requestInit });
  return new SSEClientTransport(new URL(t.url), { requestInit });
}
```

> Note: if `getDefaultEnvironment` is not exported in your installed version, drop the
> spread and pass `env` directly — verify with `node -e "import('@modelcontextprotocol/sdk/client/stdio.js').then(m=>console.log(Object.keys(m)))"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/transport.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(registry): transport factory for stdio/http/sse with secret resolution"
```

---

### Task 7: Test helper — in-memory echo downstream

**Files:**
- Create: `test/helpers/echoServer.ts`

- [ ] **Step 1: Write the helper (no test of its own; used by later tasks)**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

// A minimal downstream MCP server exposing one tool, one resource, one prompt.
// Returns the client-side transport to hand to a Client.
export async function makeEchoServer(label: string): Promise<{ server: Server; clientTransport: Transport }> {
  const server = new Server(
    { name: `echo-${label}`, version: '1.0.0' },
    { capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'echo', description: 'echoes text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => ({
    content: [{ type: 'text', text: `${label}:${(req.params.arguments as { text: string }).text}` }],
  }));
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: 'mem://greeting', name: 'greeting' }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
    contents: [{ uri: req.params.uri, text: `hello from ${label}` }],
  }));
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{ name: 'greet', description: 'greeting prompt' }],
  }));
  server.setRequestHandler(GetPromptRequestSchema, async () => ({
    messages: [{ role: 'user', content: { type: 'text', text: `prompt from ${label}` } }],
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}
```

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "test: in-memory echo downstream server helper"
```

---

### Task 8: DownstreamConnection

**Files:**
- Create: `src/registry/connection.ts`, `src/types.ts`
- Test: `test/connection.test.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
import type { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/types.js';

export type ConnState = 'connecting' | 'connected' | 'error' | 'disconnected';

export interface Capabilities {
  tools: Tool[];
  resources: Resource[];
  prompts: Prompt[];
}

export interface ServerInfo {
  id: string;
  state: ConnState;
  error?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DownstreamConnection } from '../src/registry/connection.js';
import { makeEchoServer } from './helpers/echoServer.js';

// Inject a pre-connected client by subclassing the transport build. We test the
// connection against an in-memory downstream by overriding connect via a custom def
// path: connection accepts an optional transport factory for testability.
describe('DownstreamConnection', () => {
  it('connects, fetches capabilities, and routes a tool call', async () => {
    const { clientTransport } = await makeEchoServer('A');
    const conn = new DownstreamConnection(
      { id: 'srvA', enabled: true, transport: { type: 'stdio', command: 'unused', args: [], env: {} } },
      async () => clientTransport, // injected transport factory
    );
    await conn.connect();
    expect(conn.state).toBe('connected');
    expect(conn.capabilities.tools.map((t) => t.name)).toContain('echo');
    expect(conn.capabilities.resources.map((r) => r.uri)).toContain('mem://greeting');
    expect(conn.capabilities.prompts.map((p) => p.name)).toContain('greet');

    const res = await conn.client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect((res.content as { text: string }[])[0].text).toBe('A:hi');
    await conn.close();
    expect(conn.state).toBe('disconnected');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run test/connection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/registry/connection.ts`**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerDefinition } from '../config/schema.js';
import type { Capabilities, ConnState } from '../types.js';

export type TransportFactory = (def: ServerDefinition) => Promise<Transport>;

export class DownstreamConnection {
  state: ConnState = 'connecting';
  error?: string;
  capabilities: Capabilities = { tools: [], resources: [], prompts: [] };
  readonly client: Client;

  constructor(
    readonly def: ServerDefinition,
    private readonly transportFactory: TransportFactory,
    private readonly onChange?: () => void,
  ) {
    this.client = new Client({ name: 'ai-conductor', version: '0.1.0' });
  }

  async connect(): Promise<void> {
    this.state = 'connecting';
    try {
      const transport = await this.transportFactory(this.def);
      await this.client.connect(transport);
      this.client.onclose = () => {
        if (this.state === 'connected') this.state = 'disconnected';
        this.onChange?.();
      };
      this.registerNotificationHandlers();
      await this.refresh();
      this.state = 'connected';
    } catch (err) {
      this.state = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  private registerNotificationHandlers(): void {
    const refreshAndNotify = async () => {
      await this.refresh().catch(() => undefined);
      this.onChange?.();
    };
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, refreshAndNotify);
    this.client.setNotificationHandler(ResourceListChangedNotificationSchema, refreshAndNotify);
    this.client.setNotificationHandler(PromptListChangedNotificationSchema, refreshAndNotify);
  }

  async refresh(): Promise<void> {
    const caps = this.client.getServerCapabilities() ?? {};
    this.capabilities = {
      tools: caps.tools ? (await this.client.listTools()).tools : [],
      resources: caps.resources ? (await this.client.listResources()).resources : [],
      prompts: caps.prompts ? (await this.client.listPrompts()).prompts : [],
    };
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    this.state = 'disconnected';
  }
}
```

> Note: `DownstreamConnection` takes a `TransportFactory` rather than building the
> transport itself. Production wiring passes `(def) => buildTransport(def, secrets)`;
> tests pass a factory returning an `InMemoryTransport`. This is the seam that makes
> the connection unit-testable without spawning processes.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/connection.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(registry): DownstreamConnection with capability caching and listChanged"
```

---

### Task 9: DownstreamManager

**Files:**
- Create: `src/registry/manager.ts`
- Test: `test/manager.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { DownstreamManager } from '../src/registry/manager.js';
import { makeEchoServer } from './helpers/echoServer.js';

function factoryFor(transports: Record<string, any>) {
  return async (def: { id: string }) => {
    const t = transports[def.id];
    if (!t) throw new Error(`no transport for ${def.id}`);
    return t;
  };
}

describe('DownstreamManager', () => {
  it('starts enabled servers and lists their info', async () => {
    const a = await makeEchoServer('A');
    const mgr = new DownstreamManager(factoryFor({ srvA: a.clientTransport }));
    await mgr.start([{ id: 'srvA', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } }]);
    expect(mgr.list()).toEqual([
      expect.objectContaining({ id: 'srvA', state: 'connected', toolCount: 1 }),
    ]);
    await mgr.closeAll();
  });

  it('add() connects and remove() disconnects', async () => {
    const b = await makeEchoServer('B');
    const mgr = new DownstreamManager(factoryFor({ srvB: b.clientTransport }));
    await mgr.add({ id: 'srvB', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } });
    expect(mgr.get('srvB')?.state).toBe('connected');
    await mgr.remove('srvB');
    expect(mgr.get('srvB')).toBeUndefined();
  });

  it('a failing connect leaves the manager usable (error state, not a throw that kills others)', async () => {
    const c = await makeEchoServer('C');
    const mgr = new DownstreamManager(factoryFor({ srvC: c.clientTransport })); // srvBad has no transport
    await mgr.start([
      { id: 'srvBad', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } },
      { id: 'srvC', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } },
    ]);
    const info = mgr.list();
    expect(info.find((i) => i.id === 'srvBad')?.state).toBe('error');
    expect(info.find((i) => i.id === 'srvC')?.state).toBe('connected');
    await mgr.closeAll();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/registry/manager.ts`**

```ts
import { DownstreamConnection, type TransportFactory } from './connection.js';
import type { ServerDefinition } from '../config/schema.js';
import type { ServerInfo } from '../types.js';

export class DownstreamManager {
  private readonly conns = new Map<string, DownstreamConnection>();

  constructor(
    private readonly transportFactory: TransportFactory,
    private readonly onChange: () => void = () => undefined,
  ) {}

  // Connect all enabled definitions. Individual failures are captured as error state;
  // they never reject start() or prevent other servers from connecting.
  async start(defs: ServerDefinition[]): Promise<void> {
    await Promise.all(defs.filter((d) => d.enabled).map((d) => this.connectOne(d)));
  }

  private async connectOne(def: ServerDefinition): Promise<DownstreamConnection> {
    const conn = new DownstreamConnection(def, this.transportFactory, this.onChange);
    this.conns.set(def.id, conn);
    await conn.connect().catch(() => undefined); // state already set to 'error' inside connect()
    this.onChange();
    return conn;
  }

  async add(def: ServerDefinition): Promise<DownstreamConnection> {
    if (this.conns.has(def.id)) throw new Error(`server '${def.id}' already exists`);
    return this.connectOne(def);
  }

  async remove(id: string): Promise<void> {
    const conn = this.conns.get(id);
    if (!conn) return;
    await conn.close();
    this.conns.delete(id);
    this.onChange();
  }

  get(id: string): DownstreamConnection | undefined {
    return this.conns.get(id);
  }

  connected(): DownstreamConnection[] {
    return [...this.conns.values()].filter((c) => c.state === 'connected');
  }

  list(): ServerInfo[] {
    return [...this.conns.values()].map((c) => ({
      id: c.def.id,
      state: c.state,
      error: c.error,
      toolCount: c.capabilities.tools.length,
      resourceCount: c.capabilities.resources.length,
      promptCount: c.capabilities.prompts.length,
    }));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.conns.values()].map((c) => c.close()));
    this.conns.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/manager.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(registry): DownstreamManager lifecycle (start/add/remove, error isolation)"
```

---

### Task 10: Aggregator

**Files:**
- Create: `src/aggregator/aggregate.ts`
- Test: `test/aggregate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { DownstreamManager } from '../src/registry/manager.js';
import { Aggregator } from '../src/aggregator/aggregate.js';
import { makeEchoServer } from './helpers/echoServer.js';

async function setup() {
  const a = await makeEchoServer('A');
  const b = await makeEchoServer('B');
  const transports: Record<string, any> = { srvA: a.clientTransport, srvB: b.clientTransport };
  const mgr = new DownstreamManager(async (def) => transports[def.id]);
  await mgr.start([
    { id: 'srvA', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } },
    { id: 'srvB', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } },
  ]);
  return new Aggregator(mgr);
}

describe('Aggregator', () => {
  it('lists tools from all servers with namespaced names', async () => {
    const agg = await setup();
    const names = (await agg.listTools()).map((t) => t.name).sort();
    expect(names).toEqual(['srvA__echo', 'srvB__echo']);
  });

  it('routes a namespaced tool call to the owning server', async () => {
    const agg = await setup();
    const res = await agg.callTool('srvB__echo', { text: 'yo' });
    expect((res.content as { text: string }[])[0].text).toBe('B:yo');
  });

  it('namespaces resource uris and routes reads back', async () => {
    const agg = await setup();
    const resources = await agg.listResources();
    const aRes = resources.find((r) => r.name === 'greeting' && r.uri.includes('srvA'));
    expect(aRes).toBeTruthy();
    const read = await agg.readResource(aRes!.uri);
    expect((read.contents as { text: string }[])[0].text).toBe('hello from A');
  });

  it('throws a clear error for an unknown server', async () => {
    const agg = await setup();
    await expect(agg.callTool('ghost__x', {})).rejects.toThrow(/ghost/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/aggregate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/aggregator/aggregate.ts`**

```ts
import type { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/types.js';
import type { DownstreamManager } from '../registry/manager.js';
import { encodeName, decodeName, encodeUri, decodeUri } from './namespace.js';

export class Aggregator {
  constructor(private readonly manager: DownstreamManager) {}

  async listTools(): Promise<Tool[]> {
    return this.manager.connected().flatMap((c) =>
      c.capabilities.tools.map((t) => ({ ...t, name: encodeName(c.def.id, t.name) })),
    );
  }

  async listPrompts(): Promise<Prompt[]> {
    return this.manager.connected().flatMap((c) =>
      c.capabilities.prompts.map((p) => ({ ...p, name: encodeName(c.def.id, p.name) })),
    );
  }

  async listResources(): Promise<Resource[]> {
    return this.manager.connected().flatMap((c) =>
      c.capabilities.resources.map((r) => ({ ...r, uri: encodeUri(c.def.id, r.uri) })),
    );
  }

  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<any> {
    const { serverId, name } = decodeName(qualifiedName);
    return this.connOrThrow(serverId).client.callTool({ name, arguments: args });
  }

  async getPrompt(qualifiedName: string, args: Record<string, unknown>): Promise<any> {
    const { serverId, name } = decodeName(qualifiedName);
    return this.connOrThrow(serverId).client.getPrompt({ name, arguments: args as Record<string, string> });
  }

  async readResource(qualifiedUri: string): Promise<any> {
    const { serverId, uri } = decodeUri(qualifiedUri);
    return this.connOrThrow(serverId).client.readResource({ uri });
  }

  private connOrThrow(serverId: string) {
    const conn = this.manager.get(serverId);
    if (!conn || conn.state !== 'connected') {
      throw new Error(`downstream server '${serverId}' is not connected`);
    }
    return conn;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/aggregate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(aggregator): merge and route tools/resources/prompts"
```

---

### Task 11: Meta-tools

**Files:**
- Create: `src/meta/tools.ts`
- Test: `test/meta.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DownstreamManager } from '../src/registry/manager.js';
import { ConfigStore } from '../src/config/store.js';
import { MetaTools } from '../src/meta/tools.js';
import { makeEchoServer } from './helpers/echoServer.js';

async function setup() {
  const a = await makeEchoServer('A');
  const transports: Record<string, any> = { srvA: a.clientTransport };
  const mgr = new DownstreamManager(async (def) => {
    const t = transports[def.id];
    if (!t) throw new Error(`no transport for ${def.id}`);
    return t;
  });
  const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'meta-')), 'c.json'));
  await store.save({ servers: [] });
  return { meta: new MetaTools(mgr, store), mgr, store };
}

describe('MetaTools', () => {
  it('exposes add_server / remove_server / list_servers tool definitions', async () => {
    const { meta } = await setup();
    expect(meta.definitions().map((t) => t.name).sort()).toEqual(['add_server', 'list_servers', 'remove_server']);
  });

  it('add_server connects the server AND persists it', async () => {
    const { meta, mgr, store } = await setup();
    await meta.call('add_server', { id: 'srvA', transport: { type: 'stdio', command: 'x' } });
    expect(mgr.get('srvA')?.state).toBe('connected');
    expect((await store.load()).servers.map((s) => s.id)).toEqual(['srvA']);
  });

  it('remove_server disconnects AND removes from the store', async () => {
    const { meta, mgr, store } = await setup();
    await meta.call('add_server', { id: 'srvA', transport: { type: 'stdio', command: 'x' } });
    await meta.call('remove_server', { id: 'srvA' });
    expect(mgr.get('srvA')).toBeUndefined();
    expect((await store.load()).servers).toEqual([]);
  });

  it('rejects an invalid add_server payload with a tool error (not a throw)', async () => {
    const { meta } = await setup();
    const res = await meta.call('add_server', { id: 'bad__id', transport: { type: 'stdio', command: 'x' } });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/meta.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/meta/tools.ts`**

```ts
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ServerDefinitionSchema } from '../config/schema.js';
import type { ConfigStore } from '../config/store.js';
import type { DownstreamManager } from '../registry/manager.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

export class MetaTools {
  constructor(private readonly manager: DownstreamManager, private readonly store: ConfigStore) {}

  definitions(): Tool[] {
    return [
      {
        name: 'add_server',
        description: 'Add and connect a downstream MCP server at runtime. Persists across restarts.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique id, alphanumeric/hyphen, no underscores' },
            transport: { type: 'object', description: 'Transport: {type:"stdio",command,args?,env?} | {type:"http",url,headers?} | {type:"sse",url,headers?}' },
          },
          required: ['id', 'transport'],
        },
      },
      {
        name: 'remove_server',
        description: 'Disconnect and remove a downstream MCP server. Persists across restarts.',
        inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      {
        name: 'list_servers',
        description: 'List managed downstream servers with connection state and capability counts.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  has(name: string): boolean {
    return ['add_server', 'remove_server', 'list_servers'].includes(name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      if (name === 'add_server') return await this.addServer(args);
      if (name === 'remove_server') return await this.removeServer(args);
      if (name === 'list_servers') return ok(JSON.stringify(this.manager.list(), null, 2));
      return fail(`unknown meta-tool: ${name}`);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  private async addServer(args: Record<string, unknown>): Promise<ToolResult> {
    const def = ServerDefinitionSchema.parse({ id: args.id, transport: args.transport, enabled: true });
    await this.manager.add(def);
    const config = await this.store.load();
    config.servers = [...config.servers.filter((s) => s.id !== def.id), def];
    await this.store.save(config);
    const state = this.manager.get(def.id)?.state;
    return ok(`server '${def.id}' added (state: ${state}).`);
  }

  private async removeServer(args: Record<string, unknown>): Promise<ToolResult> {
    const id = String(args.id ?? '');
    if (!id) return fail('id is required');
    await this.manager.remove(id);
    const config = await this.store.load();
    config.servers = config.servers.filter((s) => s.id !== id);
    await this.store.save(config);
    return ok(`server '${id}' removed.`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/meta.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(meta): add_server/remove_server/list_servers meta-tools with persistence"
```

---

### Task 12: Upstream server wiring

**Files:**
- Create: `src/server/upstream.ts`
- Test: `test/upstream.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DownstreamManager } from '../src/registry/manager.js';
import { Aggregator } from '../src/aggregator/aggregate.js';
import { MetaTools } from '../src/meta/tools.js';
import { ConfigStore } from '../src/config/store.js';
import { buildUpstreamServer } from '../src/server/upstream.js';
import { makeEchoServer } from './helpers/echoServer.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function wired() {
  const a = await makeEchoServer('A');
  const mgr = new DownstreamManager(async () => a.clientTransport);
  await mgr.start([{ id: 'srvA', enabled: true, transport: { type: 'stdio', command: 'x', args: [], env: {} } }]);
  const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'up-')), 'c.json'));
  await store.save({ servers: [] });
  const server = buildUpstreamServer(new Aggregator(mgr), new MetaTools(mgr, store));

  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientT);
  return { client };
}

describe('upstream server', () => {
  it('exposes downstream tools AND meta-tools in tools/list', async () => {
    const { client } = await wired();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('srvA__echo');
    expect(names).toContain('add_server');
  });

  it('routes a namespaced tool call downstream', async () => {
    const { client } = await wired();
    const res = await client.callTool({ name: 'srvA__echo', arguments: { text: 'hey' } });
    expect((res.content as { text: string }[])[0].text).toBe('A:hey');
  });

  it('routes a meta-tool call (list_servers)', async () => {
    const { client } = await wired();
    const res = await client.callTool({ name: 'list_servers', arguments: {} });
    expect((res.content as { text: string }[])[0].text).toContain('srvA');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/upstream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/upstream.ts`**

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DELIM } from '../aggregator/namespace.js';
import type { Aggregator } from '../aggregator/aggregate.js';
import type { MetaTools } from '../meta/tools.js';

export function buildUpstreamServer(aggregator: Aggregator, meta: MetaTools): Server {
  const server = new Server(
    { name: 'ai-conductor', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...meta.definitions(), ...(await aggregator.listTools())],
  }));

  // Routing rule: a name containing the delimiter belongs to a downstream; otherwise
  // it is a meta-tool.
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    if (!name.includes(DELIM)) return meta.call(name, args);
    return aggregator.callTool(name, args);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await aggregator.listResources() }));
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => aggregator.readResource(req.params.uri));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: await aggregator.listPrompts() }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) =>
    aggregator.getPrompt(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>),
  );

  return server;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/upstream.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): upstream MCP server wiring downstream + meta tools"
```

---

### Task 13: Entry point + listChanged propagation + end-to-end

**Files:**
- Modify: `src/index.ts`
- Test: `test/e2e.test.ts`

- [ ] **Step 1: Write the failing end-to-end test (listChanged after add_server)**

```ts
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConductor } from '../src/index.js';
import { ConfigStore } from '../src/config/store.js';
import { makeEchoServer } from './helpers/echoServer.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('end-to-end', () => {
  it('add_server makes new tools appear and emits tools listChanged upstream', async () => {
    const a = await makeEchoServer('A');
    const store = new ConfigStore(join(mkdtempSync(join(tmpdir(), 'e2e-')), 'c.json'));
    await store.save({ servers: [] });

    // Inject a transport factory so 'srvA' resolves to our in-memory echo server.
    const conductor = await createConductor({
      store,
      transportFactory: async () => a.clientTransport,
    });

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await conductor.server.connect(serverT);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientT);

    let changed = false;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed = true; });

    expect((await client.listTools()).tools.some((t) => t.name === 'srvA__echo')).toBe(false);
    await client.callTool({ name: 'add_server', arguments: { id: 'srvA', transport: { type: 'stdio', command: 'x' } } });

    // allow notification to flush
    await new Promise((r) => setTimeout(r, 20));
    expect(changed).toBe(true);
    expect((await client.listTools()).tools.some((t) => t.name === 'srvA__echo')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/e2e.test.ts`
Expected: FAIL — `createConductor` not exported.

- [ ] **Step 3: Write `src/index.ts`**

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ConfigStore } from './config/store.js';
import { EnvSecretProvider } from './secrets/provider.js';
import { buildTransport } from './registry/transport.js';
import { DownstreamManager } from './registry/manager.js';
import { Aggregator } from './aggregator/aggregate.js';
import { MetaTools } from './meta/tools.js';
import { buildUpstreamServer } from './server/upstream.js';
import type { TransportFactory } from './registry/connection.js';

export interface ConductorOptions {
  store?: ConfigStore;
  transportFactory?: TransportFactory;
}

export interface Conductor {
  server: Server;
  manager: DownstreamManager;
  start(): Promise<void>;
}

export async function createConductor(opts: ConductorOptions = {}): Promise<Conductor> {
  const store = opts.store ?? new ConfigStore();
  const secrets = new EnvSecretProvider();
  const transportFactory = opts.transportFactory ?? ((def) => buildTransport(def, secrets));

  // onChange fires whenever capabilities/state change → tell the upstream client.
  let server: Server;
  const onChange = () => {
    server?.sendToolListChanged();
    server?.sendResourceListChanged();
    server?.sendPromptListChanged();
  };

  const manager = new DownstreamManager(transportFactory, onChange);
  const aggregator = new Aggregator(manager);
  const meta = new MetaTools(manager, store);
  server = buildUpstreamServer(aggregator, meta);

  const config = await store.load();
  await manager.start(config.servers);

  return {
    server,
    manager,
    async start() {
      await server.connect(new StdioServerTransport());
    },
  };
}

// CLI entry: only runs when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  createConductor()
    .then((c) => c.start())
    .catch((err) => {
      console.error('ai-conductor failed to start:', err);
      process.exit(1);
    });
}
```

> Note: `onChange` calls all three `send*ListChanged` methods on every change. The SDK
> only delivers those the client subscribed to / declared interest in; over-notifying is
> safe and keeps the wiring simple for the MVP.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/e2e.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite + build + typecheck**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all tests PASS, no type errors, `dist/index.js` produced with shebang.

- [ ] **Step 6: Manual smoke (optional but recommended)**

Register in Claude's MCP config (path is OS-specific) pointing at the built binary:

```json
{ "mcpServers": { "conductor": { "command": "node", "args": ["<abs>/dist/index.js"] } } }
```

Restart Claude once, then use `list_servers` and `add_server` from within Claude to add
a real downstream (e.g. an npx-based MCP server) and confirm its tools appear without a
further restart.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: conductor entry point with listChanged propagation + e2e test"
```

---

## Self-review notes (author)

- **Spec coverage:** dynamic management (Tasks 11, 13) · auth pass-through behind interface
  (Task 3, used in 6) · stdio+http+sse (Task 6) · tools+resources+prompts aggregation
  (Tasks 5, 10, 12) · persistence (Tasks 4, 11) · error isolation (Task 9) · namespacing
  (Tasks 5, 10) · tests incl. in-memory integration (Tasks 7–13). All spec sections map to tasks.
- **Deferred (per spec):** SaaS/tenancy, registry lookup, keychain backend, SEA binary — not in this plan.
- **Type consistency:** `TransportFactory`, `DownstreamConnection`, `DownstreamManager.connected()/get()/list()`,
  `Aggregator.callTool/readResource/getPrompt`, `MetaTools.call/definitions`, `buildUpstreamServer`,
  `createConductor` are referenced consistently across tasks.
- **Known MVP limitations to revisit:** (1) reconnect/backoff on downstream crash is stubbed
  (state flips to `disconnected` via `onclose`; automatic respawn is a follow-up). (2) `onChange`
  over-notifies all three listChanged types. (3) HTTP→SSE auto-fallback is NOT implemented; the
  transport type is explicit per server — acceptable since all three are user-selectable.
```
