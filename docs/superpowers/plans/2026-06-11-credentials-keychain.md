# OS-Keychain Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store downstream credentials in the OS keychain, reference them in config as `${keychain:name}`, and provide a CLI to set/remove secrets — so tokens never live in plaintext config or pass through the LLM context.

**Architecture:** A `KeychainBackend` (backed by `@napi-rs/keyring`) wraps native keychain access behind a 3-method interface. A `SecretResolver` expands `${scheme:name}` / `${VAR}` placeholders in `env`/`headers` values, dispatching to env or keychain; the existing `EnvSecretProvider` becomes a thin back-compat subclass. A `secret` CLI subcommand reads a value from hidden stdin and writes it to the keychain. The entry point dispatches `secret …` to the CLI and otherwise runs the server with a keychain-aware resolver.

**Tech Stack:** TypeScript (ESM NodeNext → `.js` relative imports), `@napi-rs/keyring@^1.3.0` (prebuilt native binaries, all major platforms), Vitest. `gen:version` runs before build/test/typecheck.

**Reference spec:** `docs/superpowers/specs/2026-06-11-credentials-keychain-design.md`

## Verified API facts

- `@napi-rs/keyring`: `new Entry(service, account)` → sync methods `getPassword(): string | null` (null when missing, **throws** if the OS backend is unavailable), `setPassword(value): void`, `deletePassword(): boolean` (true if an entry was removed). All synchronous.
- Existing `src/secrets/provider.ts` (MVP): `SecretProvider { resolve, resolveRecord }`, `EnvSecretProvider` with regex `\$\{([A-Za-z_][A-Za-z0-9_]*)\}`. `registry/transport.ts` calls `secrets.resolveRecord(env|headers)`.
- Existing `src/index.ts`: builds `const secrets = new EnvSecretProvider();`, uses it in the default `transportFactory`; has the `isMainModule(process.argv[1], import.meta.url)` CLI guard at the bottom.

## Canonical interfaces (consistent across tasks)

```ts
// src/secrets/keychain.ts
export interface KeychainBackend {
  get(name: string): string | null;   // null if missing; throws if OS backend unavailable
  set(name: string, value: string): void;
  delete(name: string): boolean;       // true if an entry was removed
}
export const KEYCHAIN_SERVICE = 'mcp-proxy-conductor';
export function osKeychain(service?: string): KeychainBackend;

// src/secrets/provider.ts
export interface SecretProvider {
  resolve(value: string): Promise<string>;
  resolveRecord(record: Record<string, string>): Promise<Record<string, string>>;
}
export interface SecretResolverOptions { env?: Record<string, string | undefined>; keychain?: KeychainBackend; }
export class SecretResolver implements SecretProvider { constructor(opts?: SecretResolverOptions); /* resolve, resolveRecord */ }
export class EnvSecretProvider extends SecretResolver { constructor(env?: Record<string, string | undefined>); }

// src/cli/secret.ts
export interface SecretIo { readSecret(): Promise<string>; out(msg: string): void; }
export function runSecretCommand(args: string[], backend: KeychainBackend, io: SecretIo): Promise<number>; // exit code
export function promptHidden(promptText: string): Promise<string>;
export function readAllStdin(): Promise<string>;
```

---

### Task 1: KeychainBackend + osKeychain

**Files:**
- Create: `src/secrets/keychain.ts`
- Test: `test/keychain.test.ts`

- [ ] **Step 1: Write the failing test `test/keychain.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { osKeychain, KEYCHAIN_SERVICE } from '../src/secrets/keychain.js';

// The OS keychain is environment-dependent and must NOT be touched in unit tests.
// We only assert the factory shape here; behavior is covered via the injected stub in
// the resolver/CLI tests, and verified manually against the real keychain at release.
describe('osKeychain', () => {
  it('exposes a stable service name', () => {
    expect(KEYCHAIN_SERVICE).toBe('mcp-proxy-conductor');
  });

  it('returns a backend with get/set/delete methods', () => {
    const kc = osKeychain();
    expect(typeof kc.get).toBe('function');
    expect(typeof kc.set).toBe('function');
    expect(typeof kc.delete).toBe('function');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/keychain.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/secrets/keychain.ts`**

```ts
import { Entry } from '@napi-rs/keyring';

// Native-keychain access behind a narrow interface so the rest of the app (and tests)
// never depend on the native module directly.
export interface KeychainBackend {
  get(name: string): string | null; // null if missing; throws if the OS backend is unavailable
  set(name: string, value: string): void;
  delete(name: string): boolean; // true if an entry was removed
}

export const KEYCHAIN_SERVICE = 'mcp-proxy-conductor';

export function osKeychain(service: string = KEYCHAIN_SERVICE): KeychainBackend {
  return {
    get: (name) => new Entry(service, name).getPassword(),
    set: (name, value) => {
      new Entry(service, name).setPassword(value);
    },
    delete: (name) => new Entry(service, name).deletePassword(),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/keychain.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(secrets): KeychainBackend interface + osKeychain (@napi-rs/keyring)"
```

---

### Task 2: SecretResolver with scheme dispatch (env + keychain)

**Files:**
- Modify (full rewrite): `src/secrets/provider.ts`
- Create: `test/secret-resolver.test.ts`
- (Leave `test/secrets.test.ts` unchanged — it must keep passing.)

- [ ] **Step 1: Write the failing test `test/secret-resolver.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { SecretResolver } from '../src/secrets/provider.js';
import type { KeychainBackend } from '../src/secrets/keychain.js';

function fakeKeychain(entries: Record<string, string>): KeychainBackend {
  return {
    get: (name) => (name in entries ? entries[name] : null),
    set: () => undefined,
    delete: () => true,
  };
}

describe('SecretResolver', () => {
  const resolver = new SecretResolver({
    env: { TOK: 'envval' },
    keychain: fakeKeychain({ 'ur-token': 'kcval' }),
  });

  it('resolves bare ${VAR} from env (back-compat)', async () => {
    expect(await resolver.resolve('Bearer ${TOK}')).toBe('Bearer envval');
  });

  it('resolves ${env:VAR} explicitly', async () => {
    expect(await resolver.resolve('${env:TOK}')).toBe('envval');
  });

  it('resolves ${keychain:NAME} from the keychain', async () => {
    expect(await resolver.resolve('Bearer ${keychain:ur-token}')).toBe('Bearer kcval');
  });

  it('resolves multiple mixed placeholders in one value', async () => {
    expect(await resolver.resolve('${env:TOK}:${keychain:ur-token}')).toBe('envval:kcval');
  });

  it('throws on an unknown scheme', async () => {
    await expect(resolver.resolve('${vault:x}')).rejects.toThrow(/vault/);
  });

  it('throws (with the name) when a keychain secret is missing', async () => {
    await expect(resolver.resolve('${keychain:nope}')).rejects.toThrow(/nope/);
  });

  it('throws when a keychain ref is used but no keychain is configured', async () => {
    await expect(new SecretResolver({ env: {} }).resolve('${keychain:x}')).rejects.toThrow(/keychain/);
  });

  it('resolveRecord expands every value', async () => {
    expect(await resolver.resolveRecord({ A: '${TOK}', B: '${keychain:ur-token}' })).toEqual({ A: 'envval', B: 'kcval' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/secret-resolver.test.ts`
Expected: FAIL — `SecretResolver` not exported.

- [ ] **Step 3: Replace `src/secrets/provider.ts` entirely with**

```ts
import type { KeychainBackend } from './keychain.js';

// SecretProvider resolves ${...} placeholders in env/header values. Schemes:
//   ${keychain:NAME} → OS keychain   ${env:VAR} → process env   ${VAR} → process env (back-compat)
export interface SecretProvider {
  resolve(value: string): Promise<string>;
  resolveRecord(record: Record<string, string>): Promise<Record<string, string>>;
}

export interface SecretResolverOptions {
  env?: Record<string, string | undefined>;
  keychain?: KeychainBackend;
}

const REF = /\$\{([^}]+)\}/g;

export class SecretResolver implements SecretProvider {
  private readonly env: Record<string, string | undefined>;
  private readonly keychain?: KeychainBackend;

  constructor(opts: SecretResolverOptions = {}) {
    this.env = opts.env ?? process.env;
    this.keychain = opts.keychain;
  }

  async resolve(value: string): Promise<string> {
    return value.replace(REF, (_, token: string) => this.lookup(token));
  }

  async resolveRecord(record: Record<string, string>): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(record)) out[k] = await this.resolve(v);
    return out;
  }

  // Resolve a single placeholder token (the text between ${ and }).
  private lookup(token: string): string {
    const idx = token.indexOf(':');
    const scheme = idx === -1 ? 'env' : token.slice(0, idx);
    const name = idx === -1 ? token : token.slice(idx + 1);

    if (scheme === 'env') {
      const v = this.env[name];
      if (v === undefined) throw new Error(`Secret reference \${${token}} is not set in the environment`);
      return v;
    }
    if (scheme === 'keychain') {
      if (!this.keychain) throw new Error(`Cannot resolve \${${token}}: no keychain backend configured`);
      const v = this.keychain.get(name); // throws if the OS keychain backend is unavailable
      if (v === null) {
        throw new Error(`Secret '${name}' not found in the OS keychain (store it with: mcp-proxy-conductor secret set ${name})`);
      }
      return v;
    }
    throw new Error(`Unknown secret scheme '${scheme}' in \${${token}}`);
  }
}

// Back-compat: an env-only resolver. Existing call sites and tests keep working.
export class EnvSecretProvider extends SecretResolver {
  constructor(env: Record<string, string | undefined> = process.env) {
    super({ env });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/secret-resolver.test.ts test/secrets.test.ts`
Expected: PASS (new resolver suite + the unchanged 4 EnvSecretProvider tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(secrets): SecretResolver with env+keychain scheme dispatch"
```

---

### Task 3: `secret` CLI command

**Files:**
- Create: `src/cli/secret.ts`
- Test: `test/secret-cli.test.ts`

- [ ] **Step 1: Write the failing test `test/secret-cli.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { runSecretCommand } from '../src/cli/secret.js';
import type { KeychainBackend } from '../src/secrets/keychain.js';

function recordingBackend() {
  const store: Record<string, string> = {};
  const calls: string[] = [];
  const backend: KeychainBackend = {
    get: (n) => (n in store ? store[n] : null),
    set: (n, v) => { store[n] = v; calls.push(`set:${n}`); },
    delete: (n) => { const had = n in store; delete store[n]; calls.push(`del:${n}`); return had; },
  };
  return { backend, store, calls };
}

function io(secret: string) {
  const lines: string[] = [];
  return { io: { readSecret: async () => secret, out: (m: string) => lines.push(m) }, lines };
}

describe('runSecretCommand', () => {
  it('set stores the value in the keychain', async () => {
    const { backend, store } = recordingBackend();
    const { io: i, lines } = io('s3cret');
    const code = await runSecretCommand(['set', 'ur-token'], backend, i);
    expect(code).toBe(0);
    expect(store['ur-token']).toBe('s3cret');
    expect(lines.join('\n')).toContain('ur-token');
  });

  it('set never echoes the secret value in its output', async () => {
    const { backend } = recordingBackend();
    const { io: i, lines } = io('super-secret-value');
    await runSecretCommand(['set', 'ur-token'], backend, i);
    expect(lines.join('\n')).not.toContain('super-secret-value');
  });

  it('set with an empty value aborts with a non-zero code and stores nothing', async () => {
    const { backend, calls } = recordingBackend();
    const { io: i } = io('');
    const code = await runSecretCommand(['set', 'ur-token'], backend, i);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
  });

  it('rm deletes the entry', async () => {
    const { backend, store } = recordingBackend();
    store['ur-token'] = 'x';
    const { io: i } = io('');
    const code = await runSecretCommand(['rm', 'ur-token'], backend, i);
    expect(code).toBe(0);
    expect('ur-token' in store).toBe(false);
  });

  it('prints usage and returns non-zero for an unknown subcommand or missing name', async () => {
    const { backend } = recordingBackend();
    const { io: i, lines } = io('');
    expect(await runSecretCommand(['bogus'], backend, i)).toBe(1);
    expect(await runSecretCommand(['set'], backend, i)).toBe(1);
    expect(lines.join('\n').toLowerCase()).toContain('usage');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/secret-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/cli/secret.ts`**

```ts
import { createInterface } from 'node:readline';
import type { KeychainBackend } from '../secrets/keychain.js';

export interface SecretIo {
  readSecret(): Promise<string>;
  out(msg: string): void;
}

const USAGE = 'usage: mcp-proxy-conductor secret <set|rm> <name>';

// Returns a process exit code. Never logs the secret value.
export async function runSecretCommand(args: string[], backend: KeychainBackend, io: SecretIo): Promise<number> {
  const [sub, name] = args;

  if (sub === 'set') {
    if (!name) {
      io.out(USAGE);
      return 1;
    }
    const value = await io.readSecret();
    if (!value) {
      io.out('aborted: empty value, nothing stored');
      return 1;
    }
    backend.set(name, value);
    io.out(`stored secret '${name}' in the OS keychain.`);
    return 0;
  }

  if (sub === 'rm') {
    if (!name) {
      io.out(USAGE);
      return 1;
    }
    const existed = backend.delete(name);
    io.out(existed ? `removed secret '${name}'.` : `no secret '${name}' found.`);
    return 0;
  }

  io.out(USAGE);
  return 1;
}

// Read a secret without echoing it to the terminal. Used for the real CLI wiring.
export function promptHidden(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Mute keystroke echo: write the prompt once, then swallow the characters readline echoes.
    let promptWritten = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rl as any)._writeToOutput = (chunk: string) => {
      if (!promptWritten) {
        process.stdout.write(promptText);
        promptWritten = true;
      }
    };
    rl.question(promptText, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

// Read all of a piped (non-TTY) stdin as the secret value (enables scripting).
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/secret-cli.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(cli): secret set/rm command (hidden stdin, keychain-backed)"
```

---

### Task 4: Wire keychain resolver + secret CLI into the entry point

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Edit `src/index.ts`**

Add imports (after the `buildUpstreamServer` import line):

```ts
import { SecretResolver } from './secrets/provider.js';
import { osKeychain } from './secrets/keychain.js';
import { runSecretCommand, promptHidden, readAllStdin } from './cli/secret.js';
```

Extend `ConductorOptions` (add a `secrets` override for testability):

```ts
export interface ConductorOptions {
  store?: ConfigStore;
  transportFactory?: TransportFactory;
  cache?: CapabilityCache;
  idleMs?: number;
  secrets?: SecretResolver;
}
```

Replace the secrets construction line. Find:

```ts
  const secrets = new EnvSecretProvider();
```

(or whatever currently builds `secrets`) and replace with:

```ts
  const secrets = opts.secrets ?? new SecretResolver({ env: process.env, keychain: osKeychain() });
```

Remove the now-unused `EnvSecretProvider` import from `src/index.ts` if present (it is replaced by `SecretResolver`).

Replace the CLI guard block at the bottom. Find the existing:

```ts
if (isMainModule(process.argv[1], import.meta.url)) {
  createConductor()
    .then((c) => c.start())
    .catch((err) => {
      console.error('ai-conductor failed to start:', err);
      process.exit(1);
    });
}
```

with:

```ts
if (isMainModule(process.argv[1], import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'secret') {
    runSecretCommand(argv.slice(1), osKeychain(), {
      readSecret: () => (process.stdin.isTTY ? promptHidden('Secret value: ') : readAllStdin()),
      out: (m) => console.log(m),
    })
      .then((code) => process.exit(code))
      .catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
  } else {
    createConductor()
      .then((c) => c.start())
      .catch((err) => {
        console.error('ai-conductor failed to start:', err);
        process.exit(1);
      });
  }
}
```

- [ ] **Step 2: Full gate**

Run: `pnpm test && pnpm typecheck && pnpm build`
Expected: all tests pass, no type errors, `dist/index.js` built with shebang. (No existing test exercises the `secrets` default; tests inject `transportFactory`, so the new `osKeychain()` default is never hit in tests.)

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: wire keychain resolver and secret CLI into entry point"
```

---

### Task 5: Manual verification + release 0.1.3

**Files:** none (operational).

- [ ] **Step 1: Build and verify the secret CLI against the real OS keychain (this machine: macOS)**

```bash
pnpm build
# store a throwaway secret, then prove resolution end-to-end
printf 'hello-kc-value' | node dist/index.js secret set demo-token
```
Then run a scripted MCP session against `node dist/index.js`: `add_server` with id `kctest`, transport `{ "type":"stdio","command":"node","args":["-e","process.stdin.resume()"] }` is not meaningful for resolution — instead verify resolution directly by adding an HTTP server def whose header is `"Authorization": "Bearer ${keychain:demo-token}"` and confirm via logging/an echo that the resolved header contains `hello-kc-value` (or unit-confirm through `SecretResolver` against `osKeychain()` in a one-off node script). Finally clean up:
```bash
node dist/index.js secret rm demo-token
```
Document the observed result (resolved value matched; rm reported removal).

- [ ] **Step 2: Bump version + push + release**

```bash
npm version 0.1.3 --no-git-tag-version
git add -A && git commit -m "chore(release): 0.1.3"
git push
gh release create v0.1.3 --title "v0.1.3" --notes "OS-keychain credentials: store secrets with 'mcp-proxy-conductor secret set <name>' and reference them in config as \${keychain:<name>}. Secrets never touch plaintext config or the LLM context."
```
Watch the trusted-publishing workflow:
```bash
gh run watch "$(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status
```

- [ ] **Step 3: Update the global install**

```bash
npm i -g mcp-proxy-conductor@0.1.3
```

---

### Task 6: README rewrite

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite `README.md` so a new user can install and use the proxy**

Keep the existing structure (title, why, diagram) and ensure these sections are present, accurate, and concrete:

1. **Install & register** — `npx -y mcp-proxy-conductor` and the Claude Code `claude mcp add` form; manual MCP config JSON; Node ≥ 20.
2. **Managing servers** — the `add_server` / `remove_server` / `list_servers` meta-tools with the exact `transport` shapes (stdio/http/sse) and an example.
3. **Credentials** (NEW — the core of this change):
   - Store a secret: `mcp-proxy-conductor secret set <name>` (reads hidden stdin; or pipe: `printf '%s' "$TOKEN" | mcp-proxy-conductor secret set <name>`), and `secret rm <name>`.
   - Reference it in `add_server`: `"headers": { "Authorization": "Bearer ${keychain:<name>}" }` (and `env` for stdio).
   - Also supported: `${env:VAR}` and bare `${VAR}` from the process environment.
   - Note: secrets live in the OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service), never in `config.json` or the chat. On headless Linux without a Secret Service daemon, use `${env:…}` instead.
4. **Lazy connections** — downstreams connect on first use and evict after an idle timeout (`CONDUCTOR_IDLE_TIMEOUT_MS`, default 5 min); tools are advertised from a cache so they appear without connecting.
5. **Development** — `pnpm install` / `pnpm test` / `pnpm build`.
6. Keep the **Status & limitations** and **License** sections; update limitations to reflect that keychain credentials now exist (remove that from the "planned" list).

Write it tightly and accurately — do not document behavior that does not exist. Verify each command against the actual `package.json` bin name (`mcp-proxy-conductor`) and the actual meta-tool names.

- [ ] **Step 2: Commit**

```bash
git add README.md && git commit -m "docs: README covering install, server management, and keychain credentials"
```

> README is documentation only — it ships in the npm tarball but needs no separate release. It can ride along with the 0.1.3 release (do Task 6 before Task 5's release commit if you want it included in 0.1.3), or land afterward.

---

## Self-review notes (author)

- **Spec coverage:** reference syntax `${keychain:}`/`${env:}`/`${VAR}` (Task 2) · `@napi-rs/keyring` backend behind interface (Task 1) · CLI `secret set`/`rm` with hidden stdin, no value in output (Task 3) · entry wiring + arg dispatch (Task 4) · error handling: unknown scheme / missing secret / no-keychain-configured all throw clear messages (Task 2 tests); OS-backend-unavailable propagates from `osKeychain().get` (manual note) · never log secret (Task 3 test) · packaging dependency (already added) · tests with injected stub, no real OS access (Tasks 2-3) · README (Task 6). All spec sections map to tasks.
- **Ordering note:** README (Task 6) may run before the Task 5 release commit so it ships in 0.1.3; both orders are fine.
- **Type consistency:** `KeychainBackend {get,set,delete}`, `KEYCHAIN_SERVICE`, `osKeychain()`, `SecretResolver`/`SecretResolverOptions`, `EnvSecretProvider extends SecretResolver`, `runSecretCommand(args,backend,io)`, `SecretIo {readSecret,out}` — used consistently across tasks and the index wiring.
- **Back-compat:** `EnvSecretProvider` retained as a subclass so `test/secrets.test.ts` and `test/transport.test.ts` keep passing unchanged; the broadened `${[^}]+}` regex still resolves their `${MY_TOKEN}`/`${TOK}` cases.
- **Known acceptable:** `osKeychain` itself is not unit-tested against the real OS (environment-dependent); covered by the injected-stub tests + manual release verification. The `isMainModule` `secret` dispatch is thin glue over the unit-tested `runSecretCommand`.
```
