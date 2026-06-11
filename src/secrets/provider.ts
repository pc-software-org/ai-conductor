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
