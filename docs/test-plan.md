# Test-Plan

Dieser Plan beschreibt, wie der jeweils aktuelle M-Stand manuell überprüft
wird. Die automatischen Vitest-Suiten unter `packages/cli/test/` decken
das Verhalten der reinen Funktionen ab; dieser Plan deckt die
End-to-End-Strecke ab, die Tests nicht treffen können (echtes Docker,
Auth-Pass-Through, Shell-Ergonomie).

Stand: M1 Tasks 1–6.

## Stages

Drei Stufen, in absteigender Reihenfolge der Erreichbarkeit:

- **A — CLI-Surface**: nur Node, sonst nichts. Verifiziert dass das CLI
  gebaut ist.
- **B — Scaffolding**: Solution-Generierung. Schreibt nur Files, kein
  Docker nötig.
- **C — Devcontainer/Compose**: braucht Docker. Verifiziert dass die
  generierten Files real funktionieren.

## Voraussetzungen

| Was                                                     | Wozu                      |
| ------------------------------------------------------- | ------------------------- |
| Node ≥ 20, pnpm 11                                      | Das Workbench-Repo selbst |
| `pnpm install` einmalig im Repo gelaufen                | Setup vor allem anderen   |
| Docker Desktop (oder Docker Engine + Compose v2)        | Nur für Stage C           |
| `claude login` auf dem Host (Subscription oder API-Key) | Für die Auth-Probe in C.8 |

## Setup: `monoceros` lokal aufrufbar machen

Das CLI ist noch nicht publiziert (`"private": true`); wird erst mit
Task 8 als globales Paket bereitgestellt. Bis dahin reicht ein
Session-Alias, der direkt auf den TypeScript-Quellcode zeigt:

```sh
alias monoceros="$(pwd)/packages/cli/node_modules/.bin/tsx $(pwd)/packages/cli/src/bin.ts"
```

Voraussetzung: das Kommando wird **einmal aus dem Workbench-Root**
gesetzt, damit `$(pwd)` die richtigen absoluten Pfade liefert.

Eigenschaften:

- Lebt nur in der aktuellen Shell — keine `.zshrc`, kein PATH-Eingriff,
  keine globale Installation
- Pfade sind absolut → funktioniert anschließend von jeder cwd aus
- Beim Schließen des Terminals oder `exec zsh` ist er weg

Verifikation:

```sh
monoceros --version        # 0.1.0-dev
monoceros --help           # Listing aller 9 Subcommands
```

Aufräumen erübrigt sich — der Alias ist mit der Shell weg.

## Arbeitsverzeichnis: `.local/`

Alle manuellen Tests legen ihre Solutions unter `<workbench>/.local/play/`
ab. Vorteile:

- `.local/` ist in `.gitignore` → keine versehentlichen Commits von
  Test-Artefakten
- Liegt im Repo statt unter `/tmp` → ein einziges `rm -rf .local` setzt
  alles zurück, unabhängig davon ob Container noch Volumes halten
- Multiple Test-Sessions können nebeneinander koexistieren (`.local/play`,
  `.local/scratch`, …)

```sh
mkdir -p .local/play && cd .local/play
```

## Stage A — CLI-Surface

Schnelle Sanity-Checks, kein Filesystem-Effekt.

| ID  | Was                            | Befehl                         | Erwartet                                                                                               | Deckt     |
| --- | ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------ | --------- |
| A.1 | Alle 9 Subcommands registriert | `monoceros --help`             | Listing mit `create`, `shell`, `run`, `logs`, `start`, `stop`, `status`, `add-service`, `add-language` | Task 1    |
| A.2 | Versionsangabe stimmt          | `monoceros --version`          | `0.1.0-dev`                                                                                            | Task 1    |
| A.3 | `create`-Args sichtbar         | `monoceros create --help`      | Args: `name` (positional), `--languages`, `--services`, `--postgres-url`                               | Task 1, 3 |
| A.4 | `logs`-Args sichtbar           | `monoceros logs --help`        | Args: `--project`, `--service`, `--follow`                                                             | Task 1, 6 |
| A.5 | Stub-Commands leben noch nicht | `monoceros add-service --help` | Hilfetext + (Aufruf ohne Args) Hinweis "not yet implemented"                                           | Task 1    |

**Fail-Bedeutung:** wenn A.1 nicht alle 9 zeigt, ist die
Subcommand-Registrierung in `packages/cli/src/main.ts` kaputt.

## Stage B — Scaffolding (kein Docker)

Arbeitsverzeichnis: `<workbench>/.local/play/`. Alle Befehle relativ
dazu.

```sh
mkdir -p .local/play && cd .local/play
```

| ID   | Was                             | Befehl                                                                               | Erwartet                                                                                                                                                                                               | Deckt     |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| B.1  | Bare-Solution (Image-Mode)      | `monoceros create demo`                                                              | Verzeichnis `demo/` mit `.devcontainer/devcontainer.json` (`image: …typescript-node…`, kein `dockerComposeFile`), `.devcontainer/post-create.sh` (executable), `.monoceros/stack.json`, `README.md`    | Task 2, 3 |
| B.2  | Sprach-Feature                  | `monoceros create demo-py --languages=python`                                        | `devcontainer.json` enthält `features: { "ghcr.io/devcontainers/features/python:1": {} }`                                                                                                              | Task 3    |
| B.3  | Compose-Mode mit Services       | `monoceros create demo-svc --services=postgres,redis`                                | `devcontainer.json` ohne `image`, dafür `dockerComposeFile: "compose.yaml"` + `service: workspace` + `workspaceFolder: /workspaces/demo-svc`. `compose.yaml` mit `workspace`, `postgres:18`, `redis:8` | Task 3    |
| B.4  | External Postgres               | `monoceros create demo-ext --services=postgres --postgres-url=postgres://example/db` | `stack.json` hat `services: []` und `externalServices.postgres: "postgres://…"`. Keine `compose.yaml`                                                                                                  | Task 3    |
| B.5  | Idempotenz                      | `monoceros create demo` ein zweites Mal                                              | Info-Message "already initialized", Exit 0, keine Datei-Änderung                                                                                                                                       | Task 3    |
| B.6  | Konflikt                        | `monoceros create demo --languages=python` (vorher ohne)                             | Error, Exit 1, Hinweis auf `add-service` / `add-language`                                                                                                                                              | Task 3    |
| B.7  | Whitelist                       | `monoceros create x --languages=cobol`                                               | Error "Unknown language: cobol. Known: …"                                                                                                                                                              | Task 3    |
| B.8  | Path-Traversal blocked          | `monoceros create ../escape`                                                         | Error "Invalid solution name"                                                                                                                                                                          | Task 3    |
| B.9  | Status ohne Solution            | (Workbench-Root, also außerhalb von Solutions) `monoceros status`                    | Error "No .devcontainer/ found at or above …"                                                                                                                                                          | Task 6    |
| B.10 | Status ohne Compose             | `cd .local/play/demo && monoceros status`                                            | Error "No compose.yaml … require services configured via add-service. Use monoceros shell …"                                                                                                           | Task 6    |
| B.11 | Run ohne `--`                   | `monoceros run` (irgendwo)                                                           | Error "No command provided. Usage: monoceros run … -- \<cmd\>"                                                                                                                                         | Task 5    |
| B.12 | Run mit `--` außerhalb Solution | (Workbench-Root) `monoceros run -- ls`                                               | Error "No .devcontainer/ found …" (nicht "no command")                                                                                                                                                 | Task 5    |

**Fail-Bedeutung:**

- B.1–B.4 fehlerhaft → Generator hat einen Bug (siehe
  `packages/cli/src/create/scaffold.ts`)
- B.5/B.6 fehlerhaft → Idempotenz-Check in
  `packages/cli/src/create/index.ts` ist kaputt
- B.7/B.8 fehlerhaft → `validateOptions` lässt was durch, das nicht
  durchsollte
- B.9–B.12 fehlerhaft → Cwd-Awareness oder Compose-Resolution bricht

Aufräumen Stage B (vom Workbench-Root):

```sh
rm -rf .local/play
```

## Stage C — Devcontainer/Compose (Docker erforderlich)

Vorab: `docker info` muss ohne Fehler laufen. Wenn nicht: Docker Desktop
starten.

Setup-Solution:

```sh
mkdir -p .local/play && cd .local/play
monoceros create demo --languages=python --services=postgres
cd demo
```

| ID  | Was                                   | Befehl                                                                                                                                                                                      | Erwartet                                                                                                                                                                                                                      | Deckt     |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| C.1 | Compose-Lifecycle starten             | `monoceros start`                                                                                                                                                                           | `devcontainer up --workspace-folder …` läuft (nicht `docker compose up`). Image-Pull beim Erstaufruf, dann Build-Layer für Features (z. B. python), `postCreateCommand` läuft am Ende und installiert die Claude-CLI. Exit 0. | Task 6    |
| C.2 | Status zeigt Container                | `monoceros status`                                                                                                                                                                          | Tabelle: `workspace` und `postgres` jeweils mit State `running`                                                                                                                                                               | Task 6    |
| C.3 | Logs filterbar                        | `monoceros logs --service=postgres --no-follow`                                                                                                                                             | Postgres-Init-Log endet mit "database system is ready to accept connections"                                                                                                                                                  | Task 6    |
| C.4 | One-off-Run im Container              | `monoceros run -- node --version`                                                                                                                                                           | `devcontainer up` ist idempotent (Container ist seit C.1 hochgefahren), `devcontainer exec` findet ihn per Label, gibt Node-Version aus, Exit 0                                                                               | Task 5    |
| C.5 | Exit-Code-Propagation                 | `monoceros run -- bash -c 'exit 7'; echo $?`                                                                                                                                                | Letzte Zeile: `7`                                                                                                                                                                                                             | Task 5    |
| C.6 | Postgres aus dem Container erreichbar | `monoceros run -- bash -c 'apt-get update >/dev/null && apt-get install -y postgresql-client >/dev/null && PGPASSWORD=monoceros psql -h postgres -U monoceros -d monoceros -c "select 1;"'` | Spalte `?column?` mit Wert `1`. Beweist: Compose-Netzwerk funktioniert, Service-Discovery via Hostname `postgres` greift.                                                                                                     | Task 3, 6 |
| C.7 | Interaktive Shell                     | `monoceros shell`                                                                                                                                                                           | Drinnen: Prompt im Container, `whoami` → `node`, `pwd` → `/workspaces/demo`                                                                                                                                                   | Task 4    |
| C.8 | Auth-Pass-Through (Vorabprobe)        | im `monoceros shell`: `claude --version` und dann `claude` (kurz Hello sagen, exit)                                                                                                         | `claude` ist auth'd ohne Login-Prompt — die `~/.claude`-Bind-Mount-Auth aus dem Host greift. _Voller Auth-Smoke ist Task 10, das hier ist eine Vorab-Sichtprobe._                                                             | Task 2, 4 |
| C.9 | Stop preserviert Volumes              | `monoceros stop` dann `monoceros start` dann C.6 erneut                                                                                                                                     | C.6 funktioniert wieder, ohne erneuten Init. Zeigt: `stop` (nicht `down`) lässt Volumes leben.                                                                                                                                | Task 6    |

**Fail-Bedeutung:**

- C.1 hängt → Image-Pull-Problem oder Docker-Daemon-Issue, prüf
  `docker compose -f .devcontainer/compose.yaml up -d` direkt
- C.4 schlägt beim Claude-CLI-Install fehl → npm/Network-Issue im
  Container; Egress-Whitelist ist im Default-Image noch nicht aktiv
  (kommt Task 8), sollte also kein Block sein
- C.6 fehlerhaft → Compose-Netzwerk falsch konfiguriert; prüf
  `compose.yaml` ob `workspace` und `postgres` im selben Default-Network
  sind (sind sie, weil Compose das implizit erzeugt)
- C.8 verlangt erneutes Login → Bind-Mount-Pfad falsch oder Permissions
  auf `~/.claude` blocken den `node`-User

Aufräumen Stage C (vom Workbench-Root):

```sh
# in der Solution: Volumes weg
cd .local/play/demo
docker compose -f .devcontainer/compose.yaml down -v

# zurück und alles wegwerfen
cd ../../..
rm -rf .local/play
```

## Was bewusst noch nicht abgedeckt ist

- `add-service` / `add-language` mit Diff-Preview → Task 7
- Eigenes gehärtetes Runtime-Image inkl. Egress-Whitelist → Task 8
- Drei-Pfade-Verifikation (VS Code Dev Containers / Cursor / Claude
  Code direkt) → Task 9
- Auth-Smoke auf zweitem Rechner → Task 10
