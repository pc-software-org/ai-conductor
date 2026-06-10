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
