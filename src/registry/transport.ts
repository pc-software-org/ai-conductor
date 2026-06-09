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
