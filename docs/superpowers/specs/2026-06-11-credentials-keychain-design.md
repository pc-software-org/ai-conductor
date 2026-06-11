# OS-Keychain Credentials-Handling — Design

**Datum:** 2026-06-11
**Status:** Freigegeben (Brainstorming abgeschlossen)
**Baut auf:** [MVP-Design](2026-06-09-ai-conductor-mvp-design.md), [Late-Bind](2026-06-10-late-bind-design.md)

## Motivation

Heute referenziert ai-conductor Secrets nur über `${VAR}` aus der Prozess-Umgebung
(`EnvSecretProvider`). Wer per `add_server` einen Token literal mitgibt, landet im
**Klartext** in `config.json`. Die ursprüngliche Vision (CLAUDE.md) verlangt: Credentials
nicht im Klartext, sondern referenziert, abgelegt im OS-Secrets-Backend. Dieses Design
liefert das **OS-Keychain-Backend**.

## Zielzustand

- Secret-Werte liegen im OS-Keychain (macOS Keychain, Windows Credential Manager, Linux
  Secret Service), **nie** im Klartext in der Config.
- In `config.json` stehen nur Referenzen wie `${keychain:my-token}`.
- Secrets gelangen über einen **CLI-Befehl** in den Keychain — nie durch den LLM-Kontext.
- Cross-Platform (harte Bedingung), Install ohne Compiler.

## Bibliothek

**`@napi-rs/keyring`** (1.3.0). Begründung: `keytar` ist abgekündigt; `@napi-rs/keyring`
wrappt das gepflegte Rust-`keyring-rs`, ist aktiv gewartet und liefert **vorgebaute
Binaries** für alle relevanten Plattformen (darwin/win32/linux × x64/arm64, gnu+musl) —
`npx`/`npm i -g` zieht automatisch das passende Binary, kein Compiler nötig. API:
`new Entry(service, account)` mit `.getPassword()`, `.setPassword(v)`, `.deletePassword()`.

> Backends: macOS Keychain, Windows Credential Manager, Linux Secret Service (libsecret/
> D-Bus). Linux-Headless ohne laufenden Secret-Service-Daemon → siehe Fehlerbehandlung.

## Referenz-Syntax (rückwärtskompatibel)

Secrets werden in `env`/`headers`-Werten als `${...}`-Platzhalter referenziert, mit
Schema-Dispatch innerhalb der Klammer:

- `${keychain:NAME}` → Wert aus dem OS-Keychain (Account `NAME`).
- `${env:VAR}` → Wert aus `process.env` (explizit).
- `${VAR}` → `process.env` (bestehendes Verhalten, bleibt unverändert).

Komponierbar in Strings: `"Authorization": "Bearer ${keychain:ur-token}"`. Mehrere
Platzhalter pro Wert erlaubt. Damit steht in `config.json` nie ein Klartext-Secret.

Parsing-Regel: Platzhalter matcht `\$\{([^}]+)\}`. Inhalt mit `:` → in `scheme` und `name`
splitten (am ersten `:`); `keychain` → Keychain, `env` → Env; Inhalt ohne `:` → Env
(Rückwärtskompatibilität). Unbekanntes Schema → Fehler.

## Komponenten

| Datei | Aufgabe |
|---|---|
| `src/secrets/keychain.ts` | `KeychainSecretProvider`: Keychain-Zugriff über `@napi-rs/keyring`; Service-Name `mcp-proxy-conductor`. Das Keychain-Backend liegt hinter einem schmalen Interface (`KeychainBackend` mit `get/set/delete`), das in Tests durch ein Stub ersetzt wird — **kein** echter OS-Zugriff in Tests. |
| `src/secrets/provider.ts` | Erweitern um einen Resolver, der `${scheme:name}`/`${VAR}` parst und an Env bzw. Keychain dispatcht. Das `SecretProvider`-Interface (`resolve(value)`, `resolveRecord(record)`) bleibt unverändert — `registry/transport.ts` ruft es weiter auf. |
| `src/cli/secret.ts` | CLI-Befehle `secret set <name>` / `secret rm <name>`. |
| `src/index.ts` | Arg-Dispatch am Entry: `argv[2] === 'secret'` → CLI-Pfad; sonst Server-Pfad. Im Server-Pfad den kombinierten Env+Keychain-Resolver verdrahten (statt `EnvSecretProvider`). |

### Resolver-Design (Isolation)
Ein `SecretResolver implements SecretProvider`, konstruiert mit zwei Quellen: einer
Env-Map und einem `KeychainBackend`. `resolve()` ersetzt jeden `${...}`-Platzhalter über
den Schema-Dispatch. So bleibt die Schema-Logik an **einer** Stelle, getrennt vom
konkreten Keychain-Zugriff. `KeychainSecretProvider`/`KeychainBackend` kapselt nur den
nativen Zugriff.

## CLI

- `mcp-proxy-conductor secret set <name>` — liest den Wert **verdeckt** von stdin (kein
  Terminal-Echo; nicht als Argument, damit er nicht in der Shell-History/Prozessliste
  landet), legt ihn im Keychain unter Service `mcp-proxy-conductor`, Account `<name>` ab.
  Gibt eine Bestätigung **ohne** den Wert aus.
- `mcp-proxy-conductor secret rm <name>` — löscht den Keychain-Eintrag.
- Kein `get`/`list`: einen Secret-Wert auszugeben wäre unklug; `keyring-rs` kann nicht
  portabel enumerieren. YAGNI.

Verdecktes Einlesen: TTY-Echo während der Eingabe abschalten (z.B. `readline` mit
`output`-Mute bzw. `process.stdin` raw, Eingabe bis Newline). Bei nicht-interaktivem stdin
(Pipe) wird der gepipte Inhalt als Wert genommen (ermöglicht Skripting), ohne Echo-Logik.

## Fehlerbehandlung

- **Keychain nicht verfügbar** (z.B. headless Linux ohne Secret-Service): Auflösen einer
  `${keychain:…}`-Referenz wirft beim Connect einen klaren Fehler → der betroffene
  Downstream geht in `error`-State (sichtbar in `list_servers`); andere Server laufen
  weiter. Env-Referenzen sind davon unabhängig.
- **Fehlendes Secret** (`getPassword` liefert null): klarer Fehler mit dem Namen.
- **Unbekanntes Schema** in `${scheme:…}`: klarer Fehler.
- Secret-Werte werden **nie** geloggt; die CLI bestätigt ohne den Wert.

## Packaging

`@napi-rs/keyring` als reguläre `dependency`. Die optionalen Plattform-Binary-Pakete
werden von npm beim Install automatisch passend gezogen. Wir shippen weiterhin nur
`dist/` (tsup bündelt unseren JS-Code; das native Addon wird zur Laufzeit aus
`node_modules` aufgelöst).

## Tests (Vitest)

- **Resolver** (`SecretResolver`): `${env:X}`, `${keychain:X}`, bare `${X}`, mehrere/
  gemischte Platzhalter in einem String, unbekanntes Schema → Fehler, fehlendes Secret →
  Fehler. Mit **injiziertem Fake-`KeychainBackend`** (kein echter OS-Zugriff).
- **KeychainSecretProvider**: `get/set/delete` gegen ein Backend-Stub.
- **CLI `secret set`/`rm`**: Handler mit Keychain-Stub und simuliertem stdin; verifiziert,
  dass (a) der Wert im Backend landet bzw. gelöscht wird und (b) der Wert nicht in der
  Bestätigungsausgabe erscheint.

## Nicht im Scope

- `secret list`/`get`. Enumeration ist nicht portabel; Wert-Ausgabe unsicher.
- Verschlüsselter Datei-Store als Alternative (separat verworfen zugunsten Keychain).
- Mandantengetrennte Secret-Namespaces (SaaS) — die `KeychainBackend`-Abstraktion verbaut
  das nicht, aber es ist hier nicht gebaut.

## README (Folge-Deliverable, nach der Implementierung)

Eigener Schritt nach dem Merge: README so überarbeiten, dass Nutzer Installation,
Registrierung bei Claude, den Secret-Flow (`secret set` → `${keychain:…}` in `add_server`),
ein Beispiel, Plattform-Hinweise (Linux Secret Service) und das Late-Bind/Idle-Verhalten
verstehen.
