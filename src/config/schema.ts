import { z } from 'zod';

// serverId: starts alphanumeric, then alphanumerics/hyphens. No underscores → can never
// contain the '__' namespacing delimiter.
const ServerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'id must be alphanumeric/hyphen, no underscores');

const StdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

const HttpTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
});

const SseTransportSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
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
