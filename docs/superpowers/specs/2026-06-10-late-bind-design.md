# Late-Bind / Lazy-Connect für Downstreams — Design (0.1.2)

**Datum:** 2026-06-10
**Status:** Freigegeben (Brainstorming abgeschlossen)
**Baut auf:** [MVP-Design](2026-06-09-ai-conductor-mvp-design.md)

## Motivation

Der conductor soll viele Downstream-MCPs bündeln. Heute verbindet er **beim Start
alle** Downstreams (`manager.start`), bevor der Upstream hochkommt. Das skaliert
schlecht (N idle Child-Prozesse/Verbindungen, Auth, Latenz) und ein langsamer/hängender
Downstream verzögert oder blockiert die Upstream-Verfügbarkeit (in der Praxis gesehen:
Health-Check-Timeout beim Start mit einem entfernten Downstream).

**Ziel:** Verbindungen erst bei konkretem Zugriff aufbauen (Late-Bind) und nach
Inaktivität wieder trennen. Nur tatsächlich genutzte Downstreams verbrauchen Ressourcen.

## MCP-Constraint (warum reines Lazy nicht reicht)

Claude ruft nur Tools auf, die es vorher in `tools/list` gesehen hat. Der conductor muss
Capabilities **annoncieren**, bevor irgendein Zugriff stattfindet. Reines „erst bei
Zugriff verbinden" ist deshalb unmöglich ohne **persistierten Capability-Cache**: aus dem
Cache annoncieren, die echte Verbindung lazy beim Aufruf herstellen.

## Scope

**Drin (0.1.2):** Lazy-Connect, Capability-Cache, Idle-Eviction, Refresh-on-connect mit
`listChanged`, angepasste Meta-Tools. **Löst nebenbei** das Startup-Blocking (Start
verbindet keine Downstreams mehr).

**Nicht drin:** Hintergrund-Polling/Revalidierung, per-Server konfigurierbarer Timeout,
Reconnect-Backoff über das hier Beschriebene hinaus. YAGNI.

## Zustandsmodell

`ConnState` erweitert um `idle`:
`idle` (bekannt, Caps ggf. gecacht, nicht verbunden) · `connecting` · `connected` ·
`error` · `disconnected`.

Default nach dem Laden der Definitionen: `idle`.

## Capability-Cache

- Neue Datei **`capabilities.json`** im selben OS-Config-Verzeichnis wie `config.json`
  (env-paths). `config.json` bleibt **Quelle der Wahrheit** für Definitionen; der Cache
  ist abgeleitet und jederzeit regenerierbar/löschbar.
- Pro Server: `{ id, tools, resources, prompts, fetchedAt }`.
- Eigener `CapabilityCache` (Store + Schema), damit `ConfigStore` fokussiert bleibt.
- Robustheit: ein korrupter/fehlender Cache ist nicht fatal — wird wie „kein Cache"
  behandelt (Server wird beim Start im Hintergrund einmalig gefüllt, s. u.).

## Startverhalten

1. Definitionen laden → pro Server `DownstreamConnection` im Zustand `idle`, Caps aus
   `capabilities.json` laden falls vorhanden → **null Verbindungen**, sofort annoncierbar.
2. Server **ohne** gecachte Caps (Migration / nie verbunden): einmalig **im Hintergrund**
   verbinden, Caps holen + cachen, dann zurück auf `idle`. Blockiert den Upstream nicht;
   `listChanged` wird emittiert, sobald die Caps vorliegen.
3. Upstream-stdio kommt sofort hoch.

## Connect-on-demand + Idle-Eviction

- `DownstreamConnection.ensureConnected()`: verbindet, falls `idle`/`disconnected`/
  `error`. **Dedupe** über ein einzelnes In-Flight-Connect-Promise — parallele Zugriffe
  lösen genau einen Connect aus.
- Der `Aggregator` ruft `ensureConnected()` in `callTool`/`readResource`/`getPrompt`
  **vor** dem Routing auf.
- Jeder Zugriff (re)startet einen **Idle-Timer**: Default **5 min**, überschreibbar via
  `CONDUCTOR_IDLE_TIMEOUT_MS`. Ablauf → Verbindung trennen, Zustand `idle`, Caps bleiben
  im Cache. Nächster Zugriff verbindet neu.
- Annoncierung (`list*`) liest weiterhin Caps — jetzt aus dem in-memory gehaltenen
  Cache-Stand, unabhängig vom Verbindungszustand (also auch für `idle` Server).

## Staleness / Refresh

Bei **jedem** echten Connect: Caps frisch holen → mit Cache vergleichen → bei Abweichung
`capabilities.json` aktualisieren **und** `listChanged` nach oben. Kein Hintergrund-Polling.
Wird ein Tool geroutet, das nach Refresh nicht mehr existiert → klare MCP-Fehlerantwort.

## Meta-Tools

- `add_server`: einmal verbinden (validiert + füllt Cache). Erfolg → `connected` mit
  laufendem Idle-Timer. Fehler → Definition trotzdem persistieren, Fehler im Tool-Ergebnis,
  Server bleibt `idle`/`error` und wird später lazy erneut versucht.
- `remove_server`: trennt (falls verbunden), entfernt Definition aus `config.json` **und**
  Eintrag aus `capabilities.json`.
- `list_servers`: zeigt zusätzlich Verbindungszustand (`idle`/`connected`/…) und ob Caps
  aus dem Cache stammen.

## Fehlerbehandlung

- Lazy-Connect-Fehler beim Aufruf → `isError`-Ergebnis mit Server-id, kein Hängen.
- Ein toter Downstream verschwindet **nicht** aus der Annoncierung (Caps bleiben gecacht);
  Aufrufe scheitern sauber, bis er wieder erreichbar ist.
- Idle-Timer wird bei `close()`/`remove` sauber gecleared (kein Leak, kein Reconnect-Geist).

## Bewusster Trade-off

**Erstzugriff-Latenz**: der Connect passiert beim ersten Tool-Call eines bislang idle
Servers (Sekunden). Inhärent zu Late-Bind und akzeptiert.

## Komponenten (Touchpoints)

| Datei | Änderung |
|---|---|
| `src/config/capability-cache.ts` | **neu**: Schema + Store für `capabilities.json` |
| `src/types.ts` | `ConnState` um `idle`; ggf. `CachedCapabilities`-Typ |
| `src/registry/connection.ts` | `idle`-Default, `ensureConnected()` mit Dedupe, Idle-Timer, Refresh-on-connect + Cache-Update + onChange bei Diff |
| `src/registry/manager.ts` | `start()` verbindet nicht mehr eager; legt `idle`-Connections aus Cache an, füllt uncached im Hintergrund; reicht Cache + Idle-Timeout durch |
| `src/aggregator/aggregate.ts` | `ensureConnected()` vor Routing; `list*` aus Cache-Caps (auch für idle) |
| `src/meta/tools.ts` | `add_server` cached Caps; `remove_server` räumt Cache; `list_servers` zeigt Zustand/Cache-Herkunft |
| `src/index.ts` | Cache-Store verdrahten; Idle-Timeout aus Env |

## Tests (Vitest)

- `CapabilityCache` load/save round-trip; korrupter Cache → wie leer behandelt.
- `ensureConnected` Dedupe: paralleler Zugriff → genau ein Connect.
- Idle-Timer trennt nach Ablauf (Fake-Timer), nächster Zugriff verbindet neu.
- Start: annonciert aus Cache **ohne** Verbindung; uncached Server werden im Hintergrund
  gefüllt und lösen `listChanged` aus.
- Refresh-on-connect: geänderte Downstream-Caps aktualisieren Cache + emittieren
  `listChanged`.
- e2e: idle Server, erster `callTool` verbindet lazy und routet korrekt; nach Idle-Ablauf
  erneuter `callTool` reconnectet.
