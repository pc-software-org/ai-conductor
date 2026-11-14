import { isAbsolute } from 'node:path';
import { z } from 'zod';

// serverId: starts alphanumeric, then alphanumerics/hyphens. No underscores → can never
// contain the '__' namespacing delimiter.
const ServerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'id must be alphanumeric/hyphen, no underscores');

const StdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  // Arbeitsverzeichnis des Kindprozesses. Ohne Angabe erbt er das des Clients, und das
  // wechselt je Session (z.B. waehlt corepack die pnpm-Version nach dem package.json dort).
  // Nur absolute Pfade, ein relativer haette dasselbe Problem.
  cwd: z.string().refine(isAbsolute, 'cwd must be an absolute path').optional(),
});

const HttpTransportSchema = z.object({
  type: z.literal('http'),
  url: z.url(),
  headers: z.record(z.string(), z.string()).default({}),
});

const SseTransportSchema = z.object({
  type: z.literal('sse'),
  url: z.url(),
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
  // Ein einzelner Wiederholungsversuch beim Verbindungsaufbau, nur fuer stdio.
  // Default an; abschaltbar fuer Server, bei denen ein zweiter Spawn stoert
  // (teurer Start, Seiteneffekte beim Hochfahren) oder die Diagnose verschleiert.
  autoRetry: z.boolean().default(true),
  transport: TransportSchema,
});

export const ConfigSchema = z.object({
  servers: z.array(ServerDefinitionSchema).default([]),
});

export type ServerDefinition = z.infer<typeof ServerDefinitionSchema>;
export type Config = z.infer<typeof ConfigSchema>;
