# Test-Plan

Dieser Plan beschreibt, wie der jeweils aktuelle M-Stand manuell überprüft
wird. Die automatischen Vitest-Suiten unter `packages/cli/test/` decken
das Verhalten der reinen Funktionen ab; dieser Plan deckt die
End-to-End-Strecke ab, die Tests nicht treffen können (echtes Docker,
Auth-Pass-Through, Shell-Ergonomie).

Stand: M1 Tasks 1–6 am 2026-05-10 end-to-end auf macOS (Apple Silicon,
Docker Desktop) durchlaufen — Stage A/B/C komplett. Task 7
(`add-service` / `add-language`) ist über Stage B abgedeckt; die
Mutationen brauchen keinen Docker. Stage A/B sind zusätzlich durch 51
Vitest-Cases unter `packages/cli/test/` deterministisch abgesichert.

Bugs, die der erste Walkthrough gefunden und behoben hat:

- Compose-Project-Name-Split zwischen `monoceros start` (docker compose,
  Project = `devcontainer`) und `monoceros run/shell` (`@devcontainers/cli`,
  Project = `<solution>_devcontainer`). Behoben durch konsistentes
  `-p <solution>_devcontainer` in den Compose-Passthroughs.
- Postgres 18 verlangt Volume-Mount auf `/var/lib/postgresql` statt
  `/var/lib/postgresql/data`.
- `monoceros start` hat Container ohne `devcontainer`-Labels angelegt,
  sodass `monoceros run/shell` "Dev container not found" warfen.
  Behoben durch Umstellung auf `devcontainer up` (mit `runServices`).
- `monoceros run` hat `@devcontainers/cli`-Banner und JSON-Outcome
  vermischt mit der Inner-Command-Ausgabe ausgespuckt. `up`-Step ist
  jetzt stumm im Erfolgsfall.

## Stages

Drei Stufen, in absteigender Reihenfolge der Erreichbarkeit:

- **A — CLI-Surface**: nur Node, sonst nichts. Verifiziert dass das CLI
  gebaut ist.
- **B — Scaffolding**: Solution-Generierung. Schreibt nur Files, kein
  Docker nötig.
- **C — Devcontainer/Compose**: braucht Docker. Verifiziert dass die
  generierten Files real funktionieren.

## Voraussetzungen

| Was                                                                                          | Wozu                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Node ≥ 20, pnpm 11                                                                           | Das Workbench-Repo selbst                        |
| `pnpm install` einmalig im Repo gelaufen                                                     | Setup vor allem anderen                          |
| Docker Desktop (oder Docker Engine + Compose v2)                                             | Nur für Stage C                                  |
| Runtime-Image lokal gebaut: `pnpm image:build` (alias `pnpm image:rebuild` für `--no-cache`) | Wird vom Default-Template referenziert (Stage C) |
| `claude login` auf dem Host (Subscription oder API-Key)                                      | Für die Auth-Probe in C.8                        |

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
| A.5 | `add-service`-Args sichtbar    | `monoceros add-service --help` | Args: `service` (positional), `--project`, `--yes`/`-y`                                                | Task 1, 7 |

**Fail-Bedeutung:** wenn A.1 nicht alle 9 zeigt, ist die
Subcommand-Registrierung in `packages/cli/src/main.ts` kaputt.

## Stage B — Scaffolding (kein Docker)

Arbeitsverzeichnis: `<workbench>/.local/play/`. Alle Befehle relativ
dazu.

```sh
mkdir -p .local/play && cd .local/play
```

| ID   | Was                             | Befehl                                                                               | Erwartet                                                                                                                                                                                                                                                        | Deckt        |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| B.1  | Bare-Solution (Image-Mode)      | `monoceros create demo`                                                              | Verzeichnis `demo/` mit `.devcontainer/devcontainer.json` (`image: monoceros-runtime:dev`, `runArgs: ["--cap-add=NET_ADMIN"]`, kein `dockerComposeFile`), `.devcontainer/post-create.sh` (executable, nur `pnpm install`), `.monoceros/stack.json`, `README.md` | Task 2, 3, 8 |
| B.2  | Sprach-Feature                  | `monoceros create demo-py --languages=python`                                        | `devcontainer.json` enthält `features: { "ghcr.io/devcontainers/features/python:1": {} }`                                                                                                                                                                       | Task 3       |
| B.3  | Compose-Mode mit Services       | `monoceros create demo-svc --services=postgres,redis`                                | `devcontainer.json` ohne `image`, dafür `dockerComposeFile: "compose.yaml"` + `service: workspace` + `workspaceFolder: /workspaces/demo-svc`. `compose.yaml` mit `workspace` (`image: monoceros-runtime:dev`, `cap_add: [NET_ADMIN]`), `postgres:18`, `redis:8` | Task 3, 8    |
| B.4  | External Postgres               | `monoceros create demo-ext --services=postgres --postgres-url=postgres://example/db` | `stack.json` hat `services: []` und `externalServices.postgres: "postgres://…"`. Keine `compose.yaml`                                                                                                                                                           | Task 3       |
| B.5  | Idempotenz                      | `monoceros create demo` ein zweites Mal                                              | Info-Message "already initialized", Exit 0, keine Datei-Änderung                                                                                                                                                                                                | Task 3       |
| B.6  | Konflikt                        | `monoceros create demo --languages=python` (vorher ohne)                             | Error, Exit 1, Hinweis auf `add-service` / `add-language`                                                                                                                                                                                                       | Task 3       |
| B.7  | Whitelist                       | `monoceros create x --languages=cobol`                                               | Error "Unknown language: cobol. Known: …"                                                                                                                                                                                                                       | Task 3       |
| B.8  | Path-Traversal blocked          | `monoceros create ../escape`                                                         | Error "Invalid solution name"                                                                                                                                                                                                                                   | Task 3       |
| B.9  | Status ohne Solution            | (Workbench-Root, also außerhalb von Solutions) `monoceros status`                    | Error "No .devcontainer/ found at or above …"                                                                                                                                                                                                                   | Task 6       |
| B.10 | Status ohne Compose             | `cd .local/play/demo && monoceros status`                                            | Error "No compose.yaml … require services configured via add-service. Use monoceros shell …"                                                                                                                                                                    | Task 6       |
| B.11 | Run ohne `--`                   | `monoceros run` (irgendwo)                                                           | Error "No command provided. Usage: monoceros run … -- \<cmd\>"                                                                                                                                                                                                  | Task 5       |
| B.12 | Run mit `--` außerhalb Solution | (Workbench-Root) `monoceros run -- ls`                                               | Error "No .devcontainer/ found …" (nicht "no command")                                                                                                                                                                                                          | Task 5       |
| B.13 | add-language fügt Feature an    | in einer bare Solution: `monoceros add-language python --yes`                        | Diff-Preview zeigt `+ "ghcr.io/devcontainers/features/python:1": {}`, danach "✔ Updated solution"; `devcontainer.json` enthält `features`-Eintrag, `stack.json.languages` = `["python"]`                                                                        | Task 7       |
| B.14 | add-language idempotent         | Wiederholung von B.13                                                                | "No changes — solution is already in the desired state.", Exit 0, Files unverändert                                                                                                                                                                             | Task 7       |
| B.15 | add-language Whitelist          | `monoceros add-language cobol`                                                       | Error "Unknown language: cobol …", Exit 1                                                                                                                                                                                                                       | Task 7       |
| B.16 | add-service Image→Compose       | in einer bare Solution: `monoceros add-service postgres --yes`                       | Diff: `devcontainer.json` switcht von `image:` auf `dockerComposeFile`+`service:workspace`+`runServices:[postgres]`; `compose.yaml` neu mit `workspace`+`postgres:18`; `stack.json.services`=`[postgres]`                                                       | Task 7       |
| B.17 | add-service idempotent          | Wiederholung von B.16                                                                | "No changes — solution is already in the desired state.", Exit 0                                                                                                                                                                                                | Task 7       |
| B.18 | add-service ohne `--yes`        | `monoceros add-service redis` (Prompt mit `n` beantworten)                           | Diff angezeigt, dann Prompt "Apply these changes?", Antwort `n` → "Aborted by user. No files were written.", Exit 1, Solution unverändert                                                                                                                       | Task 7       |

**Fail-Bedeutung:**

- B.1–B.4 fehlerhaft → Generator hat einen Bug (siehe
  `packages/cli/src/create/scaffold.ts`)
- B.5/B.6 fehlerhaft → Idempotenz-Check in
  `packages/cli/src/create/index.ts` ist kaputt
- B.7/B.8 fehlerhaft → `validateOptions` lässt was durch, das nicht
  durchsollte
- B.9–B.12 fehlerhaft → Cwd-Awareness oder Compose-Resolution bricht
- B.13–B.18 fehlerhaft → Mutator-Logik in
  `packages/cli/src/modify/index.ts` ist kaputt; das Re-Generate-vom-Stack
  -Modell ist die zentrale Idempotenz-Garantie und sollte nie in-place
  patchen

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

| ID   | Was                                   | Befehl                                                                                                                                                                   | Erwartet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Deckt          |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C.1  | Compose-Lifecycle starten             | `monoceros start`                                                                                                                                                        | `devcontainer up --workspace-folder …` läuft (nicht `docker compose up`). Image-Pull beim Erstaufruf, dann Build-Layer für Features (z. B. python), `postCreateCommand` läuft am Ende und installiert die Claude-CLI. Exit 0.                                                                                                                                                                                                                                                                                                        | Task 6         |
| C.2  | Status zeigt Container                | `monoceros status`                                                                                                                                                       | Tabelle: `workspace` und `postgres` jeweils mit State `running`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Task 6         |
| C.3  | Logs filterbar                        | `monoceros logs --service=postgres --no-follow`                                                                                                                          | Postgres-Init-Log endet mit "database system is ready to accept connections"                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Task 6         |
| C.4  | One-off-Run im Container              | `monoceros run -- node --version`                                                                                                                                        | Gibt Node-Version aus, Exit 0. `claude --version` gleich danach läuft sofort durch (CLI ist im Runtime-Image vorinstalliert, kein npm-Install im post-create mehr).                                                                                                                                                                                                                                                                                                                                                                  | Task 5, 8      |
| C.5  | Exit-Code-Propagation                 | `monoceros run -- bash -c 'exit 7'; echo $?`                                                                                                                             | Letzte Zeile: `7`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Task 5         |
| C.6  | Postgres aus dem Container erreichbar | `monoceros run -- bash -c '(echo > /dev/tcp/postgres/5432) && echo "TCP reachable: postgres:5432"'`                                                                      | Output: `TCP reachable: postgres:5432`. Beweist: DNS für Hostname `postgres` löst innerhalb des Compose-Default-Networks auf, Port 5432 nimmt Verbindungen an. Geht durch obwohl Egress-Whitelist aktiv ist — RFC1918 ist unconditional erlaubt für Compose-interne Services.                                                                                                                                                                                                                                                        | Task 3, 6      |
| C.7  | Interaktive Shell                     | `monoceros shell`                                                                                                                                                        | Drinnen: Prompt im Container, `whoami` → `node`, `pwd` → `/workspaces/demo`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Task 4         |
| C.8  | Auth-Pass-Through (Vorabprobe)        | im `monoceros shell`: `claude --version`, dann `claude` (kurz Hello sagen, exit). Anschließend `monoceros stop && monoceros start && monoceros run -- claude --version`. | **macOS-Erstaufruf**: OAuth-Login im Container (Code aus Browser einfügen). Grund: Claude auf macOS speichert Credentials in der Keychain, die ist außerhalb des Containers nicht zugänglich — der Bind-Mount kann beim ersten Mal nichts mitbringen. **Folge-Aufrufe**: kein Login-Prompt mehr, weil der in-Container-Login `~/.claude/.credentials.json` in den Bind-Mount geschrieben hat und der nun persistiert. Der zweite `monoceros run -- claude --version` muss ohne Re-Auth durchlaufen. _Voller Auth-Smoke ist Task 10._ | Task 2, 4      |
| C.9  | Stop preserviert Volumes              | `monoceros stop` dann `monoceros start` dann C.6 erneut                                                                                                                  | C.6 funktioniert wieder, ohne erneuten Init. Zeigt: `stop` (nicht `down`) lässt Volumes leben.                                                                                                                                                                                                                                                                                                                                                                                                                                       | Task 6         |
| C.10 | Egress-Whitelist greift               | im laufenden Container: `monoceros run -- bash -c '(timeout 3 bash -c "echo > /dev/tcp/example.com/443") && echo ALLOWED                                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | echo BLOCKED'` | Output: `BLOCKED`. Plus Gegenprobe `monoceros run -- bash -c '(timeout 3 bash -c "echo > /dev/tcp/api.anthropic.com/443") && echo ALLOWED |     | echo BLOCKED'`→`ALLOWED`. Beweist: das Runtime-Image setzt die iptables-Rules durch, Default-Liste enthält die nötigen Hosts. Bei Fail: `cap_add: [NET_ADMIN]`fehlt im`compose.yaml`, dann loggt der Entrypoint die Warnung und Egress läuft offen. | Task 8 |

**Fail-Bedeutung:**

- C.1 hängt → Image-Pull-Problem oder Docker-Daemon-Issue, prüf
  `docker compose -f .devcontainer/compose.yaml up -d` direkt
- C.4 schlägt beim Claude-CLI-Install fehl → npm/Network-Issue im
  Container; Egress-Whitelist ist im Default-Image noch nicht aktiv
  (kommt Task 8), sollte also kein Block sein
- C.6 fehlerhaft → Compose-Netzwerk falsch konfiguriert; prüf
  `compose.yaml` ob `workspace` und `postgres` im selben Default-Network
  sind (sind sie, weil Compose das implizit erzeugt). Häufige Ursache
  für ein Hängen statt Fehler: postgres ist noch im Init und horcht
  noch nicht auf 5432.
- C.8 verlangt _Folge-Login_ (zweiter Run nach stop/start) → Bind-Mount-Pfad
  falsch oder Permissions auf `~/.claude`/`.credentials.json` blocken den
  `node`-User. Diagnose: `monoceros run -- ls -la /home/node/.claude`. Der
  einmalige Erst-Login auf macOS ist erwartet, kein Bug.

### Aufräumen Stage C (vom Workbench-Root):

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
