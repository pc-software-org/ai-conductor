# ai-conductor — MVP Design

**Datum:** 2026-06-09
**Status:** Freigegeben (Brainstorming abgeschlossen)

## Zweck

Lokaler **MCP-Proxy / -Aggregator**. Wird bei einem MCP-Client (Claude Desktop /
Claude Code) **einmal** als Server eingetragen und sitzt davor als Vermittler zu
mehreren, zur Laufzeit verwalteten Downstream-MCP-Servern.

Gelöstes Problem: Einzelne MCP-Server sind umständlich einzurichten und erzwingen
einen Agent-Restart bei jeder Änderung. ai-conductor entkoppelt das — Downstreams
werden hinzugefügt/entfernt, ohne den vorgelagerten Client neu zu starten.

## MVP-Scope

**Drin:**
- Lokaler Proxy: ein stdio-MCP-Server gegenüber Claude.
- **Laufzeit-Verwaltung** der Downstreams über Meta-Tools (das Kernproblem).
- Downstream-Transports: **stdio + Streamable HTTP + SSE-Fallback** (max. Kompatibilität).
- Aggregation von **Tools + Resources + Prompts**, jeweils mit Namespacing.
- Auth **durchgereicht**, hinter einem austauschbaren Interface gekapselt.
- Persistenz der Server-Definitionen über Neustarts.

**Bewusst NICHT im MVP (spätere Iterationen):**
- SaaS / Mandantenfähigkeit (Architektur darf es nicht verbauen, baut es aber nicht).
- Anbindung von MCP-Lookup-Registries.
- Keychain-/Secrets-Backend (Interface vorbereitet, Implementierung später).

## Stack

- **TypeScript auf Node.js** (Node ≥ 20; Dev: v26).
- **`@modelcontextprotocol/sdk`** (aktuell 1.29.0) — ein Prozess, beide Rollen:
  `Server`+stdio nach oben, `Client`+stdio/StreamableHTTP/SSE nach unten.
- **pnpm** (PM), **Vitest** (Tests), **tsup/esbuild** (Build).
- Auslieferung als npm-Paket, Start via `npx ai-conductor`. Claude-Eintrag zeigt auf npx.
- Cross-Platform: Pfade via `env-paths`/`node:path`, stdio-Spawning via SDK
  `StdioClientTransport`.

## Architektur

Ein Prozess, zwei Rollen:
- **Upstream:** MCP-`Server` über stdio gegenüber Claude. Exponiert aggregierte
  Capabilities + Meta-Tools.
- **Downstream:** je Server ein MCP-`Client` mit eigenem Transport (stdio / HTTP / SSE).

```
  Claude (MCP-Client)
        │  upstream: stdio
        ▼
  ┌─────────────────────────┐
  │      ai-conductor       │   MCP-Server nach oben, MCP-Client nach unten
  └─────────────────────────┘
        │  downstream: stdio | Streamable HTTP | SSE
        ▼
  Server A   Server B   Server C  …  (zur Laufzeit verwaltet)
```

## Komponenten

Jede Komponente hat genau eine Aufgabe, kommuniziert über definierte Schnittstellen,
ist isoliert testbar.

| Datei | Aufgabe | Abhängt von |
|---|---|---|
| `src/config/schema.ts` | Zod-Schemas: `ServerDefinition`, Gesamt-Config | zod |
| `src/config/store.ts` | Persistierter JSON-Store im OS-Config-Verzeichnis (env-paths); load/save | env-paths, schema |
| `src/registry/transport.ts` | Baut Transport aus `ServerDefinition` (stdio/HTTP, SSE-Fallback) | SDK |
| `src/registry/connection.ts` | `DownstreamConnection`: Client+Transport+gecachte Capabilities+Zustand | SDK, transport |
| `src/registry/manager.ts` | `Map<serverId, DownstreamConnection>`; Lifecycle connect/disconnect/reconnect | connection, store |
| `src/aggregator/namespace.ts` | Prefix-Regel `serverId__name` (encode/decode) | — |
| `src/aggregator/aggregate.ts` | Merge Tools/Resources/Prompts; Call-Routing | manager, namespace |
| `src/meta/tools.ts` | Meta-Tools `add_server`/`remove_server`/`list_servers` (+ enable/disable) | manager, store, schema |
| `src/server/upstream.ts` | MCP-Server-Fassade gegenüber Claude | SDK, aggregate, meta |
| `src/index.ts` | Entry: Store laden → Manager starten → Upstream auf stdio | alle |

### Namespacing-Regel (invariant)
- Encode: `serverId + "__" + name`.
- Decode: split am **ersten** `__`; alles davor = serverId, Rest = Originalname.
- `serverId` darf kein `__` enthalten (Manager erzwingt + Eindeutigkeit).
- Gilt konsistent für Tool-Liste, Call-Routing, Resources, Prompts.

## Datenfluss

- **Start:** Store laden → enabled Server verbinden → Capabilities holen → im
  Aggregator registrieren → Upstream-stdio-Server starten.
- **Tool-Call:** Claude ruft `serverId__tool` → Aggregator routet → Downstream
  `client.callTool(originalName)` → Ergebnis zurück.
- **add_server:** validieren → Store persistieren → Connection aufbauen → bei Erfolg
  mergen → `listChanged` an Claude.
- **remove_server:** Connection abbauen → Store persistieren → mergen → `listChanged`.
- **Downstream meldet `listChanged`:** dessen Capabilities neu holen → neu mergen →
  `listChanged` nach oben.

## Fehlerbehandlung

- Connect-Fehler eines Downstreams crasht den Proxy **nicht**: Server bekommt
  Error-State, sichtbar in `list_servers` und im Meta-Tool-Ergebnis; andere laufen weiter.
- Laufzeit-Crash (Transport close): Zustand → disconnected, dessen Capabilities fallen
  aus dem Aggregat; **begrenzter** Reconnect (stdio respawn) mit Backoff.
- Tool-/Resource-Call an disconnected Server: klare MCP-Fehlerantwort, kein Hängen.
- `serverId`-Eindeutigkeit: Manager erzwingt; Namenskollisionen verhindert Namespacing.

## Auth

Im MVP durchgereicht, aber hinter einem `SecretProvider`-Interface gekapselt:
- stdio → Credentials als `env` an den Kindprozess.
- HTTP/SSE → Header / Bearer-Token.
- MVP-Implementierung liest Credentials aus dem Store; ein Keychain-Backend kann das
  Interface später ohne Umbau ersetzen. Auth-/Tenant-Kontext wird explizit durchgereicht,
  nicht aus globalem State gezogen (SaaS-Tauglichkeit nicht verbauen).

## Tests (Vitest)

- **Unit:** Namespacing encode/decode (inkl. Namen mit `__`), Store load/save (round-trip),
  Manager-Lifecycle mit Fake-Connection (connect/disconnect/error).
- **Integration:** echter In-Memory-Downstream über SDK `InMemoryTransport` → prüft
  Aggregation, Call-Routing, `add_server`/`remove_server`, `listChanged`-Propagation
  nach oben.

## Offen für spätere Iterationen

- SaaS/Mandantenfähigkeit auf Basis der Auth-Schicht.
- MCP-Lookup-Registry(s) zum Entdecken/Anbieten von Servern.
- OS-Keychain als `SecretProvider`-Implementierung.
- Standalone-Binary (SEA) als zusätzliche Auslieferung.
