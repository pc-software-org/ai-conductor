# ai-conductor

A local **MCP proxy / aggregator**. You register it **once** with an MCP client (e.g.
Claude Desktop or Claude Code), and it sits in front of multiple, **dynamically managed**
downstream MCP servers.

> Published on npm as [`mcp-proxy-conductor`](https://www.npmjs.com/package/mcp-proxy-conductor).

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
- **Lazy connections**: downstreams connect on first use and disconnect after an idle
  timeout; capabilities are served from a cache so tools are advertised without connecting.
- **Credentials in the OS keychain** — referenced from config, never stored in plaintext.
- **Persistence** — added servers are stored and reconnected (lazily) on the next start.

## Requirements

- Node.js ≥ 20

## Install & register

Register ai-conductor with your MCP client. With the Claude Code CLI:

```bash
claude mcp add conductor -s user -- npx -y mcp-proxy-conductor
```

Or add it manually to your client's MCP config:

```json
{
  "mcpServers": {
    "conductor": { "command": "npx", "args": ["-y", "mcp-proxy-conductor"] }
  }
}
```

Restart the client once. ai-conductor then exposes its meta-tools.

## Managing downstream servers

Manage downstreams conversationally through the meta-tools:

- **`add_server`** — add and connect a downstream server at runtime (persists).
  - `id`: unique, alphanumeric/hyphen, **no underscores**.
  - `transport`: one of
    - `{ "type": "stdio", "command": "...", "args": [...], "env": { ... } }`
    - `{ "type": "http", "url": "https://…/mcp", "headers": { ... } }`
    - `{ "type": "sse", "url": "https://…/sse", "headers": { ... } }`
- **`remove_server`** — disconnect and remove a downstream server (persists). Arg: `id`.
- **`list_servers`** — list managed servers with connection state (`idle`/`connected`/
  `error`), whether capabilities come from cache, and capability counts.

### Example

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

Its tools then appear as `filesystem__<toolname>`, callable immediately — no restart.

## Credentials

Secrets live in the **OS keychain** (macOS Keychain, Windows Credential Manager, Linux
Secret Service) — never in `config.json` and never passed through the chat.

**1. Store a secret** with the CLI (the value is read from hidden stdin, not the chat):

```bash
mcp-proxy-conductor secret set my-token
# or pipe it (e.g. in scripts):
printf '%s' "$MY_TOKEN" | mcp-proxy-conductor secret set my-token

# remove it again:
mcp-proxy-conductor secret rm my-token
```

**2. Reference it** in `add_server` via `${keychain:<name>}`:

```json
{
  "id": "uptime",
  "transport": {
    "type": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "Bearer ${keychain:my-token}" }
  }
}
```

References are resolved at connect time. Supported placeholder schemes (usable in any
`env` or `headers` value, and combinable within a string):

| Reference | Resolves from |
|---|---|
| `${keychain:NAME}` | OS keychain (service `mcp-proxy-conductor`) |
| `${env:VAR}` | process environment |
| `${VAR}` | process environment (shorthand) |

> **Headless Linux** without a running Secret Service daemon cannot use the keychain —
> use `${env:…}` there instead. A missing or unreachable secret surfaces as an `error`
> state for that one downstream (visible in `list_servers`); other servers keep working.

## Lazy connections

To scale to many downstreams, connections are **late-bound**: at startup nothing is
connected — tools/resources/prompts are advertised from a persisted capability cache. A
downstream connects on the **first actual call** and is evicted after an idle timeout
(default **5 minutes**, override with `CONDUCTOR_IDLE_TIMEOUT_MS`, in ms; `0` disables
eviction). The first call to an idle server therefore pays a one-time connect latency.

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck
pnpm build       # tsup → dist/index.js
```

## Status & limitations

Local, single-user focus. Known limitations:

- No automatic reconnect/backoff for a downstream that crashes (it returns to `idle` and
  reconnects on the next call).
- Change notifications are coarse (all `listChanged` types emitted on any change).
- HTTP downstreams do not auto-fall back to SSE; the transport type is explicit.

Planned, not yet implemented: multi-tenant/SaaS mode and MCP registry lookup.

## License

[MIT](LICENSE) © Patrick Cornelißen
