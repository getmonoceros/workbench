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

Das CLI ist noch nicht publiziert (`"private": true`), wird also nicht über
`pnpm install -g …` bezogen. Für den Endnutzer kommt das mit Task 8; für
Workbench-Contributors etablieren wir einen Symlink.

### Schritt 1 — pnpm-Globalpfad initialisieren (einmalig pro Maschine)

```sh
pnpm setup
```

Was passiert:

- pnpm legt `~/Library/pnpm/` (macOS) als Globalpfad an
- Zwei Zeilen werden in `~/.zshrc` (bzw. `~/.bashrc`) eingetragen:
  - `export PNPM_HOME="$HOME/Library/pnpm"`
  - `export PATH="$PNPM_HOME:$PATH"`
- Danach: **neue Shell öffnen** oder `source ~/.zshrc` ausführen, sonst
  greifen die Variablen nicht

Verifikation:

```sh
echo "$PNPM_HOME"          # /Users/<name>/Library/pnpm
echo "$PATH" | tr ':' '\n' | grep pnpm
```

### Schritt 2 — `monoceros` als globalen Symlink registrieren

Aus dem Workbench-Checkout:

```sh
pnpm --filter @monoceros/cli link --global
```

Was passiert:

- pnpm verlinkt das Workspace-Paket `@monoceros/cli` in seinen globalen
  Store
- Der `bin`-Eintrag aus `packages/cli/package.json` (`monoceros →
src/bin.ts`) landet als ausführbarer Symlink in `~/Library/pnpm/`
- Der Symlink zeigt auf den Workspace-Sourcecode — Code-Änderungen wirken
  sofort, kein Rebuild

Verifikation:

```sh
which monoceros            # Pfad in ~/Library/pnpm/
monoceros --version        # 0.0.0
```

### Aufräumen am Ende eines Test-Durchlaufs

```sh
pnpm --filter @monoceros/cli unlink --global
```

## Stage A — CLI-Surface

Schnelle Sanity-Checks, kein Filesystem-Effekt.

| ID  | Was                            | Befehl                         | Erwartet                                                                                               | Deckt     |
| --- | ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------ | --------- |
| A.1 | Alle 9 Subcommands registriert | `monoceros --help`             | Listing mit `create`, `shell`, `run`, `logs`, `start`, `stop`, `status`, `add-service`, `add-language` | Task 1    |
| A.2 | `create`-Args sichtbar         | `monoceros create --help`      | Args: `name` (positional), `--languages`, `--services`, `--postgres-url`                               | Task 1, 3 |
| A.3 | `logs`-Args sichtbar           | `monoceros logs --help`        | Args: `--project`, `--service`, `--follow`                                                             | Task 1, 6 |
| A.4 | Stub-Commands leben noch nicht | `monoceros add-service --help` | Hilfetext + (Aufruf ohne Args) Hinweis "not yet implemented"                                           | Task 1    |

**Fail-Bedeutung:** wenn A.1 nicht alle 9 zeigt, ist die
Subcommand-Registrierung in `packages/cli/src/main.ts` kaputt.

## Stage B — Scaffolding (kein Docker)

Arbeitsverzeichnis frisch:

```sh
mkdir -p /tmp/play && cd /tmp/play
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
| B.9  | Status ohne Solution            | `cd /tmp && monoceros status`                                                        | Error "No .devcontainer/ found at or above …"                                                                                                                                                          | Task 6    |
| B.10 | Status ohne Compose             | `cd /tmp/play/demo && monoceros status`                                              | Error "No compose.yaml … require services configured via add-service. Use monoceros shell …"                                                                                                           | Task 6    |
| B.11 | Run ohne `--`                   | `monoceros run` (irgendwo)                                                           | Error "No command provided. Usage: monoceros run … -- \<cmd\>"                                                                                                                                         | Task 5    |
| B.12 | Run mit `--` außerhalb Solution | `cd /tmp && monoceros run -- ls`                                                     | Error "No .devcontainer/ found …" (nicht "no command")                                                                                                                                                 | Task 5    |

**Fail-Bedeutung:**

- B.1–B.4 fehlerhaft → Generator hat einen Bug (siehe
  `packages/cli/src/create/scaffold.ts`)
- B.5/B.6 fehlerhaft → Idempotenz-Check in
  `packages/cli/src/create/index.ts` ist kaputt
- B.7/B.8 fehlerhaft → `validateOptions` lässt was durch, das nicht
  durchsollte
- B.9–B.12 fehlerhaft → Cwd-Awareness oder Compose-Resolution bricht

Aufräumen Stage B:

```sh
rm -rf /tmp/play
```

## Stage C — Devcontainer/Compose (Docker erforderlich)

Vorab: `docker info` muss ohne Fehler laufen. Wenn nicht: Docker Desktop
starten.

Setup-Solution:

```sh
mkdir -p /tmp/play && cd /tmp/play
monoceros create demo --languages=python --services=postgres
cd demo
```

| ID  | Was                                   | Befehl                                                                                                                                                                                      | Erwartet                                                                                                                                                          | Deckt     |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| C.1 | Compose-Lifecycle starten             | `monoceros start`                                                                                                                                                                           | `docker compose up -d` läuft. Erst-Aufruf zieht Images (`postgres:18`, Base-Image), kann ein paar Minuten dauern. Exit 0 wenn alles up.                           | Task 6    |
| C.2 | Status zeigt Container                | `monoceros status`                                                                                                                                                                          | Tabelle: `workspace` und `postgres` jeweils mit State `running`                                                                                                   | Task 6    |
| C.3 | Logs filterbar                        | `monoceros logs --service=postgres --no-follow`                                                                                                                                             | Postgres-Init-Log endet mit "database system is ready to accept connections"                                                                                      | Task 6    |
| C.4 | One-off-Run im Container              | `monoceros run -- node --version`                                                                                                                                                           | Erst-Aufruf führt `devcontainer up` (idempotent) und `post-create.sh` aus (installiert Claude-CLI), dann gibt Node-Version aus, Exit 0                            | Task 5    |
| C.5 | Exit-Code-Propagation                 | `monoceros run -- bash -c 'exit 7'; echo $?`                                                                                                                                                | Letzte Zeile: `7`                                                                                                                                                 | Task 5    |
| C.6 | Postgres aus dem Container erreichbar | `monoceros run -- bash -c 'apt-get update >/dev/null && apt-get install -y postgresql-client >/dev/null && PGPASSWORD=monoceros psql -h postgres -U monoceros -d monoceros -c "select 1;"'` | Spalte `?column?` mit Wert `1`. Beweist: Compose-Netzwerk funktioniert, Service-Discovery via Hostname `postgres` greift.                                         | Task 3, 6 |
| C.7 | Interaktive Shell                     | `monoceros shell`                                                                                                                                                                           | Drinnen: Prompt im Container, `whoami` → `node`, `pwd` → `/workspaces/demo`                                                                                       | Task 4    |
| C.8 | Auth-Pass-Through (Vorabprobe)        | im `monoceros shell`: `claude --version` und dann `claude` (kurz Hello sagen, exit)                                                                                                         | `claude` ist auth'd ohne Login-Prompt — die `~/.claude`-Bind-Mount-Auth aus dem Host greift. _Voller Auth-Smoke ist Task 10, das hier ist eine Vorab-Sichtprobe._ | Task 2, 4 |
| C.9 | Stop preserviert Volumes              | `monoceros stop` dann `monoceros start` dann C.6 erneut                                                                                                                                     | C.6 funktioniert wieder, ohne erneuten Init. Zeigt: `stop` (nicht `down`) lässt Volumes leben.                                                                    | Task 6    |

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

Aufräumen Stage C:

```sh
monoceros stop
docker compose -f .devcontainer/compose.yaml down -v   # Volumes löschen
cd /tmp && rm -rf /tmp/play
```

## Was bewusst noch nicht abgedeckt ist

- `add-service` / `add-language` mit Diff-Preview → Task 7
- Eigenes gehärtetes Runtime-Image inkl. Egress-Whitelist → Task 8
- Drei-Pfade-Verifikation (VS Code Dev Containers / Cursor / Claude
  Code direkt) → Task 9
- Auth-Smoke auf zweitem Rechner → Task 10
