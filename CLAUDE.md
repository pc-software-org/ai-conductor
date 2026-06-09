# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Status: Greenfield.** Noch kein Code vorhanden. Dieses Dokument beschreibt die
> beschlossene Vision, Architektur und den Stack. Build-/Test-Befehle werden hier
> ergänzt, sobald sie real existieren — nichts erfinden, was noch nicht da ist.

## Was ai-conductor ist

Ein **lokaler MCP-Proxy / -Aggregator**. Er wird bei einem MCP-Client (z.B. Claude
Desktop / Claude Code) **einmal** als Server eingetragen und sitzt davor als Vermittler
zu mehreren, **dynamisch verwalteten** Downstream-MCP-Servern.

Das gelöste Problem: Einzelne MCP-Server sind umständlich einzurichten und erzwingen
einen Agent-Restart bei jeder Änderung. ai-conductor entkoppelt das — Downstream-Server
werden zur Laufzeit hinzugefügt/entfernt, ohne den Client neu zu starten.

### Kernanforderungen (Reihenfolge = Priorität)
1. **Dynamisches Server-Management** — Downstream-MCP-Server zur Laufzeit hinzufügen/
   entfernen/neu laden, ohne Neustart des vorgelagerten Clients.
2. **Authentifizierung** — von Anfang an mitgedacht: Credentials je Downstream-Server,
   sichere Ablage, kein Klartext im Repo.
3. **Mandantenfähigkeit (SaaS-Option)** — Architektur so schneiden, dass später eine
   mandantengetrennte SaaS-Variante möglich ist, ohne Neubau. Lokaler Single-User-Betrieb
   bleibt aber der erste, einfache Zielzustand.
4. **MCP-Lookup-Repos** — ein oder mehrere MCP-Registry-/Lookup-Quellen einbinden und
   deren Server zur Installation/Anbindung anbieten.

## Architektur (das große Bild)

ai-conductor ist gleichzeitig **zwei Rollen**:

```
  Claude (MCP-Client)
        │  (upstream: stdio lokal, optional Streamable HTTP für SaaS)
        ▼
  ┌─────────────────────────┐
  │      ai-conductor       │   ← MCP-Server gegenüber Claude
  │  (Server + Client zugl.) │   ← MCP-Client gegenüber allen Downstreams
  └─────────────────────────┘
        │  (downstream: stdio child-process ODER Streamable HTTP/SSE)
        ▼
  MCP-Server A   MCP-Server B   MCP-Server C  …  (dynamisch verwaltet)
```

Tragende Konzepte, die mehrere Dateien betreffen werden:

- **Aggregation & Namespacing**: Tools/Resources/Prompts aller Downstreams werden
  gebündelt nach oben exponiert. Namenskollisionen werden über ein **Präfix je
  Downstream-Server** aufgelöst (z.B. `serverid__toolname`). Diese Namespacing-Regel
  ist zentral — sie muss bei Tool-Liste, Tool-Call-Routing und Capability-Change-
  Notifications konsistent angewandt werden.
- **Dynamic registry / lifecycle**: Eine zentrale Verwaltung hält pro Downstream einen
  MCP-Client + Transport, dessen Lebenszyklus (connect / disconnect / reconnect). Änderungen
  lösen `listChanged`-Notifications nach oben aus, statt einen Restart zu erfordern.
- **Config als Quelle der Wahrheit**: Downstream-Server werden in einer Konfiguration
  beschrieben (Transport-Typ, Command/URL, Auth-Referenz). Hot-Reload dieser Config ist
  der Mechanismus hinter „dynamisch hinzufügen".
- **Auth-Schicht**: Credentials werden **nicht** in der Config im Klartext gehalten,
  sondern referenziert (z.B. OS-Keychain / Secrets-Backend). Mandantentrennung baut
  später auf dieser Schicht auf — Auth-Kontext fließt durch das Routing.

## Tech-Stack & Begründung

- **TypeScript auf Node.js** (Node ≥ 20; Entwicklungsumgebung: Node v26).
  Gewählt, weil das offizielle **`@modelcontextprotocol/sdk`** (aktuell `1.29.0`) in
  TS am ausgereiftesten ist und in **einem Prozess** beide Rollen unterstützt:
  `Server` + `StreamableHTTPServerTransport`/stdio nach oben, `Client` +
  `StreamableHTTPClientTransport`/stdio (Child-Process) nach unten.
- **Cross-Platform (Linux/Windows/Mac)** ist harte Bedingung. Daraus folgt:
  - Keine plattformspezifischen Shell-Annahmen; Pfade über `node:path`, nie hartkodierte
    `/`-Trenner.
  - Child-Process-Spawning von stdio-Downstreams plattformneutral lösen (Windows:
    `.cmd`-Wrapper / `shell`-Verhalten bedenken).
  - Secrets-Backend pro Plattform abstrahieren (macOS Keychain, Windows Credential
    Manager, Linux Secret Service) hinter **einer** Schnittstelle.

> Vor dem Festlegen weiterer Bibliotheken (HTTP-Framework, Validierung, Secrets,
> Config-Loader) zuerst **context7** für aktuelle Versionen konsultieren — nicht aus
> dem Gedächtnis empfehlen.

## Konventionen für die Arbeit hier

- Die **Namespacing-Regel** (Präfix je Downstream) ist invariant: Wer Tool-Routing
  anfasst, hält sie an Liste **und** Call-Pfad synchron.
- **Dynamik vor Bequemlichkeit**: Kein Feature einführen, das einen Client-/Prozess-
  Restart erzwingt — das wäre das Problem, das ai-conductor lösen soll.
- **SaaS-Tauglichkeit nicht verbauen**: Auch im lokalen Single-User-Pfad keine globalen
  Singletons, die später Mandantentrennung unmöglich machen. Auth-/Tenant-Kontext
  explizit durchreichen, nicht implizit aus globalem State ziehen.
- Sprache im Repo/Doku: Deutsch, sofern nicht anders nötig.

## Nächste Schritte (noch offen, mit dir zu klären)

Diese Entscheidungen stehen aus und sollten vor dem ersten Code getroffen werden —
nicht raten:
- Projekt-Scaffolding (Package-Manager, Build-Tooling, Test-Runner).
- HTTP-Framework für die SaaS-/HTTP-Transport-Variante.
- Konkretes Secrets-Backend und Config-Format.
- Welche MCP-Lookup-Registry(s) zuerst angebunden werden.
