# ai-conductor

A local **MCP proxy / aggregator**. You register it **once** with an MCP client (e.g.
Claude Desktop or Claude Code), and it sits in front of multiple, **dynamically managed**
downstream MCP servers.

## Why

Individual MCP servers are fiddly to set up and force an agent restart on every change.
ai-conductor decouples that: downstream servers are added/removed **at runtime**, without
restarting the upstream client. New tools appear immediately via MCP `listChanged`
notifications.

```
  Claude (MCP client)
        │  upstream: stdio
        ▼
  ┌─────────────────────────┐
  │      ai-conductor       │   MCP server upstream, MCP client downstream
  └─────────────────────────┘
        │  downstream: stdio | Streamable HTTP | SSE
        ▼
  Server A   Server B   Server C  …  (managed at runtime)
```

## Features

- **Runtime management** of downstream servers via built-in meta-tools — no client restart.
- Downstream transports: **stdio**, **Streamable HTTP**, **SSE**.
- Aggregates **tools, resources, and prompts** from all downstreams, with per-server
  namespacing (`serverId__name`) so names never collide.
- **Persistence** — added servers are stored and reconnected on the next start.
- Auth passed through per downstream (env vars for stdio, headers for HTTP/SSE), behind a
  pluggable `SecretProvider` interface.

## Requirements

- Node.js ≥ 20

## Install & register

Register ai-conductor with your MCP client. With the Claude Code CLI:

```bash
claude mcp add conductor -s user -- npx -y ai-conductor
```

Or add it manually to your client's MCP config:

```json
{
  "mcpServers": {
    "conductor": { "command": "npx", "args": ["-y", "ai-conductor"] }
  }
}
```

Restart the client once. ai-conductor then exposes its meta-tools.

## Usage

Manage downstream servers conversationally through the meta-tools:

- **`add_server`** — add and connect a downstream server at runtime (persists).
  - `id`: unique, alphanumeric/hyphen, no underscores.
  - `transport`: one of
    - `{ "type": "stdio", "command": "...", "args": [...], "env": { ... } }`
    - `{ "type": "http", "url": "https://…/mcp", "headers": { ... } }`
    - `{ "type": "sse", "url": "https://…/sse", "headers": { ... } }`
- **`remove_server`** — disconnect and remove a downstream server (persists).
  - `id`: the server id.
- **`list_servers`** — list managed servers with connection state and capability counts.

### Example

Adding an stdio-based downstream:

```json
{
  "id": "filesystem",
  "transport": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/some/dir"]
  }
}
```

Once connected, its tools appear as `filesystem__<toolname>` and are callable
immediately — no restart.

### Secrets

`env` and `headers` values support `${VAR}` references that are expanded from the
environment at connect time, so you can avoid hardcoding tokens, e.g.
`"Authorization": "Bearer ${UPTIMEROBOT_TOKEN}"`.

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # tsup → dist/index.js
```

## Status & limitations

This is an MVP focused on the local, single-user case. Known limitations:

- No automatic reconnect/backoff for a downstream that crashes (remove + add to recover).
- Change notifications are coarse (all `listChanged` types emitted on any change).
- HTTP downstreams do not auto-fall back to SSE; the transport type is explicit.

Planned, not yet implemented: multi-tenant/SaaS mode, MCP registry lookup, OS-keychain
secret backend.

## License

[MIT](LICENSE) © Patrick Cornelißen
