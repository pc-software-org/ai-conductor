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
