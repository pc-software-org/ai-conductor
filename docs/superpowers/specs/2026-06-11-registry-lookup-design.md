# MCP Registry Lookup — Design

**Datum:** 2026-06-11
**Status:** Freigegeben (Brainstorming abgeschlossen)
**Baut auf:** [MVP](2026-06-09-ai-conductor-mvp-design.md), [Late-Bind](2026-06-10-late-bind-design.md), [Credentials](2026-06-11-credentials-keychain-design.md)

## Motivation

Server von Hand in `add_server` einzutippen ist mühsam. Registry-Lookup lässt den
conductor MCP-Server **entdecken** und direkt **anbinden** — inklusive Secret-Anleitung —
über den im Chat sprechenden Agenten.

## Quellen & Capability-Asymmetrie (verifiziert)

| Quelle | API | Suche | Strukturierte Install-Infos | Secret-Erkennung |
|---|---|---|---|---|
| **official** (`registry.modelcontextprotocol.io`) | `GET /v0/servers?search=&limit=&cursor=` | ✅ | ✅ `packages` (npm/npx/args) + `remotes` (url) | ✅ `environmentVariables[].isSecret` |
| **glama** (`glama.ai/api/mcp/v1/servers`) | cursor-paginiert | ✅ | ⚠️ `repository`/`namespace`/`slug`, kein Run-Command | ⚠️ `environmentVariablesJsonSchema` (kein `isSecret`) |
| **pulsemcp** (`api.pulsemcp.com/v0beta/servers?query=`) | offset-paginiert | ✅ | ⚠️ teils `package_name`, oft null; keine args | ❌ keine Env/Secret-Infos |

Konsequenz: **Suche** vereinheitlicht über alle drei. **Auto-Anbinden + Secret-Erkennung**
voll nur bei *official*; bei glama/pulsemcp Best-Effort.

## Such-Standard & Selektion (Kernentscheidung)

- **Default-Suche: nur `official`.** Die breiteren Quellen (glama, pulsemcp) sind **opt-in
  pro Suche**.
- Das LLM kann die Quellen **enumerieren** und gezielt **auswählen**:
  - `list_registries` → verfügbare Quellen mit `id`, Titel und Capability-Flags
    (`canConnect`, `canDetectSecrets`), damit der Agent weiß, wann Anbinden/Secrets
    funktionieren.
  - `search_registry(query, sources?)` mit `sources` als String-Array; Default `['official']`.

## Architektur

Pluggable Quellen, normalisiertes Modell:

- `RegistrySource`-Interface: `id: string`, `title: string`, `capabilities: { canConnect: boolean; canDetectSecrets: boolean }`, `search(query: string, limit: number): Promise<RegistryEntry[]>`.
- Drei Adapter, je eine API gekapselt: `official.ts`, `glama.ts`, `pulsemcp.ts`.
- Normalisiertes `RegistryEntry`:
  ```
  { source: string; ref: string; name: string; description: string;
    install?: InstallInfo; requiredEnv?: EnvRequirement[] }
  InstallInfo = { type:'stdio'; command:string; args:string[]; envNames:string[] }
              | { type:'http'|'sse'; url:string }
  EnvRequirement = { name:string; description?:string; required:boolean; secret:boolean }
  ```
  `install`/`requiredEnv` fehlen bei dünnen Einträgen.
- `RegistryAggregator`: fächert `search` über die ausgewählten Quellen **parallel**, labelt
  je Treffer die Quelle, kurzes Per-Quelle-Timeout.
- `ref`-Schema: `"<source>:<name|id>"` — stabil, eindeutig, vom `install_from_registry`
  wieder auflösbar.

## Komponenten

| Datei | Aufgabe |
|---|---|
| `src/registry-lookup/types.ts` | `RegistrySource`, `RegistryEntry`, `InstallInfo`, `EnvRequirement` |
| `src/registry-lookup/official.ts` | Adapter offizielle Registry; Mapping packages/remotes/environmentVariables → Entry (inkl. `secret` aus `isSecret`). Bei sowohl `remotes` als auch `packages`: **`remotes` (streamable-http/sse) bevorzugen** (kein Child-Prozess); sonst erstes `packages`-npm-Entry als stdio (`command: runtimeHint||'npx'`, `args: ['-y', identifier, …runtimeArguments]`). |
| `src/registry-lookup/glama.ts` | Adapter Glama; Mapping repository/env-schema → Entry (Best-Effort install) |
| `src/registry-lookup/pulsemcp.ts` | Adapter PulseMCP; Mapping package_name/remotes → Entry (Best-Effort install) |
| `src/registry-lookup/aggregate.ts` | `RegistryAggregator`: enumerate Quellen, Fan-out-Suche über ausgewählte, Timeout/Fehler-Isolation |
| `src/registry-lookup/install.ts` | `RegistryEntry` → vorgeschlagene `ServerDefinition` + Liste benötigter Secrets/Env |
| `src/meta/tools.ts` | neue Meta-Tools `list_registries`, `search_registry`, `install_from_registry` |
| `src/index.ts` | Aggregator verdrahten (mit `fetch`-basiertem HTTP), an MetaTools übergeben |

## Meta-Tools (Datenfluss)

- **`list_registries()`** → `[{ id, title, canConnect, canDetectSecrets }]`. Erlaubt dem
  LLM, Quellen zu kennen und für `search_registry` auszuwählen.
- **`search_registry(query, sources?)`** → Treffer: `ref`, `name`, `source`,
  `description`, `connectable: boolean`, `requiredSecrets: string[]`. `sources` default
  `['official']`; unbekannte/abgeschaltete Quelle in `sources` → Fehler mit Hinweis auf
  `list_registries`.
- **`install_from_registry(ref, { id?, env?, secretBindings? })`**:
  1. Eintrag (aus letztem Such-Cache oder per erneutem gezieltem Lookup) auflösen →
     vorgeschlagene `ServerDefinition`.
  2. Hat der Eintrag **Secrets** und fehlen Bindings → Rückgabe (kein Connect) mit
     Anleitung: „benötigt Secret(s) X; ablegen via `mcp-proxy-conductor secret set <name>`,
     dann erneut mit `secretBindings: { X: '<keychain-name>' }`". Conductor verdrahtet dann
     `env: { X: "${keychain:<name>}" }` — **nie** der Wert selbst.
  3. Nicht-geheime Pflicht-Env → über `env`-Arg mitgeben (landen normal in der Config).
  4. `id` default aus dem Eintragsnamen abgeleitet (auf Schema `[A-Za-z0-9-]`, keine `__`
     normalisiert); kollidiert er, Fehler.
  5. Intern `manager.add(def)` + Persistenz (wie `add_server`) → lazy-connect.
  6. Eintrag **ohne** `install` (dünn) → Rückgabe „diese Quelle liefert keine
     Run-Details; bitte via `add_server` mit command/args anbinden" (kein Raten).

## Config

`registries`-Liste der aktiven Quellen (Default alle drei **verfügbar**; Default-**Suche**
nur `official`). Abschaltbar. Lese-/Such-APIs aller drei brauchen keine Auth.

## Fehlerbehandlung

- Quelle nicht erreichbar / Timeout (kurzes Per-Quelle-Limit, z.B. 8 s) → 0 Treffer dieser
  Quelle + Vermerk; andere liefern weiter, kein Gesamtausfall.
- Unbekannte `ref` / `source` → klarer Fehler.
- `install_from_registry` mit fehlenden Pflicht-Secrets/Env → Anleitungs-Rückgabe statt
  Teil-Connect.
- HTTP via Node-`fetch` (Node ≥ 20 hat global `fetch`), defensives JSON-Parsing pro Adapter.

## Tests (Vitest)

- **Pro Adapter**: Mapping von **eingefrorenen API-Beispiel-Responses** (Fixtures, kein
  Netz) auf `RegistryEntry` — inkl. Secret-Flag (official), Best-Effort (glama/pulsemcp),
  und fehlender Install-Info.
- **Aggregator**: Default `['official']`; Selektion mehrerer Quellen; eine Quelle
  wirft/timeoutet → andere liefern weiter; unbekannte Quelle → Fehler.
- **install.ts**: official-Eintrag mit Secret → `${keychain:…}`-Binding korrekt erzeugt;
  Pflicht-Env ohne Secret → in `env`; dünner Eintrag → null/Anleitung.
- **Meta-Tools**: `list_registries` listet Capabilities; `search_registry` default-Quelle;
  `install_from_registry` Secret-Anleitung-Pfad und Erfolgs-Pfad (mit Stub-Aggregator +
  Stub-Manager).

## Nicht im Scope

- Schreibender Registry-Zugriff (Publizieren) — nur Lesen/Suchen.
- Bezahlte/authentifizierte Registry-Tiers.
- Persistenter Treffer-Cache über Prozessgrenzen (ein In-Memory-Cache der letzten Suche
  zum `ref`-Auflösen genügt; sonst erneuter gezielter Lookup).
- SaaS/Mandanten-Trennung der Quellen (Architektur verbaut es nicht).
