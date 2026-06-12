import type { RegistryEntry } from './types.js';

export interface InstallRequest {
  id?: string;
  env?: Record<string, string>;
  secretBindings?: Record<string, string>;
}

export interface InstallPlan {
  def?: unknown;
  guidance?: string;
}

/** Map a registry name to a valid server id (alphanumeric/hyphen, no underscores). */
export function normalizeId(s: string): string {
  const cleaned = s
    .replace(/[^A-Za-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'server';
}

export function buildServerDefinition(entry: RegistryEntry, req: InstallRequest): InstallPlan {
  if (!entry.install) {
    return {
      guidance: `'${entry.ref}' has no run details from source '${entry.source}'. Add it manually with add_server (provide command/args or a url).`,
    };
  }

  const id = normalizeId(req.id ?? entry.name);

  // Remote (http/sse): env/secret binding is out of scope (the registry schema gives no
  // header name for auth) — connect by URL only. requiredEnv is not applied here.
  if (entry.install.type !== 'stdio') {
    return {
      def: { id, enabled: true, transport: { type: entry.install.type, url: entry.install.url } },
    };
  }

  // stdio: required secrets must be bound to a keychain name first.
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

  // stdio: required non-secret env must be provided as plain values.
  const missingEnv = entry.requiredEnv
    .filter((e) => e.required && !e.secret)
    .filter((e) => !(req.env && e.name in req.env));
  if (missingEnv.length > 0) {
    const names = missingEnv.map((e) => e.name).join(', ');
    return {
      guidance: `'${entry.ref}' needs env value(s): ${names}. Re-run install_from_registry with env: { "${missingEnv[0].name}": "<value>" }.`,
    };
  }

  const env: Record<string, string> = { ...(req.env ?? {}) };
  for (const [envName, keychainName] of Object.entries(req.secretBindings ?? {})) {
    env[envName] = `\${keychain:${keychainName}}`;
  }
  return {
    def: {
      id,
      enabled: true,
      transport: { type: 'stdio', command: entry.install.command, args: entry.install.args, env },
    },
  };
}
