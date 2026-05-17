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

Stage E.1 am 2026-05-12 grün: Marketplace-Registrierung wirkt — alle
vier Slash-Commands (`/monoceros:iterate`, `/monoceros:findings`,
`/monoceros:triage`, `/monoceros:defer`) erscheinen automatisch beim
Container-Start, ohne dass der Builder `/plugin install` ausführen
muss. Voraussetzung war der Fix von `author` auf ein Objekt im
Plugin-Manifest (`packages/plugin/.claude-plugin/plugin.json`).

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

Fünf Stufen, in absteigender Reihenfolge der Erreichbarkeit:

- **A — CLI-Surface**: nur Node, sonst nichts. Verifiziert dass das CLI
  gebaut ist.
- **B — Scaffolding**: Solution-Generierung. Schreibt nur Files, kein
  Docker nötig.
- **C — Devcontainer/Compose**: braucht Docker. Verifiziert dass die
  generierten Files real funktionieren.
- **D — IDE-Integration**: optional, erkundet die drei realistischen
  Nutzungspfade — VS Code Dev Containers, Claude Code als VS Code-
  Extension, Claude Desktop. Cursor wird ausgeklammert (nicht im
  Einsatz).
- **E — M2 Pipeline-End-to-End**: die komplette Strecke von Solution-
  Anlage bis zur dritten Iteration mit `/monoceros:iterate`,
  `/monoceros:findings`, `/monoceros:triage`, `/monoceros:defer`.
  Verifiziert die M2-Tooling-Phase und führt
  zur Validation-Hypothesen-Bewertung (konzept.md). Braucht echten
  Anthropic-Account.

## Voraussetzungen

| Was                                                                                          | Wozu                                                 |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Node ≥ 20, pnpm 11                                                                           | Das Workbench-Repo selbst                            |
| `pnpm install` einmalig im Repo gelaufen                                                     | Setup vor allem anderen                              |
| Docker Desktop (oder Docker Engine + Compose v2)                                             | Nur für Stage C                                      |
| Runtime-Image lokal gebaut: `pnpm image:build` (alias `pnpm image:rebuild` für `--no-cache`) | Wird vom Default-Template referenziert (Stage C)     |
| `claude login` auf dem Host (Subscription oder API-Key)                                      | Für die Auth-Probe in C.8 und für Stage E (Pipeline) |

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
monoceros --help           # Listing aller 15 Subcommands
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

| ID  | Was                             | Befehl                         | Erwartet                                                                                                                                                                               | Deckt     |
| --- | ------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| A.1 | Alle 15 Subcommands registriert | `monoceros --help`             | Listing mit `create`, `shell`, `run`, `logs`, `start`, `stop`, `down`, `status`, `apply`, `add-service`, `add-language`, `add-apt-packages`, `add-feature`, `add-from-url`, `add-repo` | Task 1    |
| A.2 | Versionsangabe stimmt           | `monoceros --version`          | `0.1.0-dev`                                                                                                                                                                            | Task 1    |
| A.3 | `create`-Args sichtbar          | `monoceros create --help`      | Args: `name` (positional), `--languages`, `--services`, `--postgres-url`                                                                                                               | Task 1, 3 |
| A.4 | `logs`-Args sichtbar            | `monoceros logs --help`        | Args: `--project`, `--service`, `--follow`                                                                                                                                             | Task 1, 6 |
| A.5 | `add-service`-Args sichtbar     | `monoceros add-service --help` | Args: `service` (positional), `--project`, `--yes`/`-y`                                                                                                                                | Task 1, 7 |

**Fail-Bedeutung:** wenn A.1 nicht alle 15 zeigt, ist die
Subcommand-Registrierung in `packages/cli/src/main.ts` kaputt.

## Stage B — Scaffolding (kein Docker)

Arbeitsverzeichnis: `<workbench>/.local/play/`. Alle Befehle relativ
dazu.

```sh
mkdir -p .local/play && cd .local/play
```

| ID   | Was                             | Befehl                                                                                                                | Erwartet                                                                                                                                                                                                                                                                                                                                                                                 | Deckt        |
| ---- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| B.1  | Bare-Solution (Image-Mode)      | `monoceros create demo`                                                                                               | Verzeichnis `demo/` mit `.devcontainer/devcontainer.json` (`image: monoceros-runtime:dev`, `runArgs: ["--cap-add=NET_ADMIN"]`, kein `dockerComposeFile`), `.devcontainer/post-create.sh` (executable, nur `pnpm install`), `.monoceros/stack.json`, `README.md`, `projects/.gitkeep` (leeres `projects/`-Verzeichnis), `demo.code-workspace` (Inhalt `{ "folders": [{ "path": "." }] }`) | Task 2, 3, 8 |
| B.2  | Sprach-Feature                  | `monoceros create demo-py --languages=python`                                                                         | `devcontainer.json` enthält `features: { "ghcr.io/devcontainers/features/python:1": {} }`                                                                                                                                                                                                                                                                                                | Task 3       |
| B.3  | Compose-Mode mit Services       | `monoceros create demo-svc --services=postgres,redis`                                                                 | `devcontainer.json` ohne `image`, dafür `dockerComposeFile: "compose.yaml"` + `service: workspace` + `workspaceFolder: /workspaces/demo-svc`. `compose.yaml` mit `workspace` (`image: monoceros-runtime:dev`, `cap_add: [NET_ADMIN]`), `postgres:18`, `redis:8`                                                                                                                          | Task 3, 8    |
| B.4  | External Postgres               | `monoceros create demo-ext --services=postgres --postgres-url=postgres://example/db`                                  | `stack.json` hat `services: []` und `externalServices.postgres: "postgres://…"`. Keine `compose.yaml`                                                                                                                                                                                                                                                                                    | Task 3       |
| B.5  | Idempotenz                      | `monoceros create demo` ein zweites Mal                                                                               | Info-Message "already initialized", Exit 0, keine Datei-Änderung                                                                                                                                                                                                                                                                                                                         | Task 3       |
| B.6  | Konflikt                        | `monoceros create demo --languages=python` (vorher ohne)                                                              | Error, Exit 1, Hinweis auf `add-service` / `add-language`                                                                                                                                                                                                                                                                                                                                | Task 3       |
| B.7  | Whitelist                       | `monoceros create x --languages=cobol`                                                                                | Error "Unknown language: cobol. Known: …"                                                                                                                                                                                                                                                                                                                                                | Task 3       |
| B.8  | Path-Traversal blocked          | `monoceros create ../escape`                                                                                          | Error "Invalid solution name"                                                                                                                                                                                                                                                                                                                                                            | Task 3       |
| B.9  | Status ohne Solution            | (Workbench-Root, also außerhalb von Solutions) `monoceros status`                                                     | Error "No .devcontainer/ found at or above …"                                                                                                                                                                                                                                                                                                                                            | Task 6       |
| B.10 | Status ohne Compose             | `cd .local/play/demo && monoceros status`                                                                             | Error "No compose.yaml … require services configured via add-service. Use monoceros shell …"                                                                                                                                                                                                                                                                                             | Task 6       |
| B.11 | Run ohne `--`                   | `monoceros run` (irgendwo)                                                                                            | Error "No command provided. Usage: monoceros run … -- \<cmd\>"                                                                                                                                                                                                                                                                                                                           | Task 5       |
| B.12 | Run mit `--` außerhalb Solution | (Workbench-Root) `monoceros run -- ls`                                                                                | Error "No .devcontainer/ found …" (nicht "no command")                                                                                                                                                                                                                                                                                                                                   | Task 5       |
| B.13 | add-language fügt Feature an    | in einer bare Solution: `monoceros add-language python --yes`                                                         | Diff-Preview zeigt `+ "ghcr.io/devcontainers/features/python:1": {}`, danach "✔ Updated solution"; `devcontainer.json` enthält `features`-Eintrag, `stack.json.languages` = `["python"]`                                                                                                                                                                                                 | Task 7       |
| B.14 | add-language idempotent         | Wiederholung von B.13                                                                                                 | "No changes — solution is already in the desired state.", Exit 0, Files unverändert                                                                                                                                                                                                                                                                                                      | Task 7       |
| B.15 | add-language Whitelist          | `monoceros add-language cobol`                                                                                        | Error "Unknown language: cobol …", Exit 1                                                                                                                                                                                                                                                                                                                                                | Task 7       |
| B.16 | add-service Image→Compose       | in einer bare Solution: `monoceros add-service postgres --yes`                                                        | Diff: `devcontainer.json` switcht von `image:` auf `dockerComposeFile`+`service:workspace`+`runServices:[postgres]`; `compose.yaml` neu mit `workspace`+`postgres:18`; `stack.json.services`=`[postgres]`                                                                                                                                                                                | Task 7       |
| B.17 | add-service idempotent          | Wiederholung von B.16                                                                                                 | "No changes — solution is already in the desired state.", Exit 0                                                                                                                                                                                                                                                                                                                         | Task 7       |
| B.18 | add-service ohne `--yes`        | `monoceros add-service redis` (Prompt mit `n` beantworten)                                                            | Diff angezeigt, dann Prompt "Apply these changes?", Antwort `n` → "Aborted by user. No files were written.", Exit 1, Solution unverändert                                                                                                                                                                                                                                                | Task 7       |
| B.19 | add-apt-packages mehrere Pakete | in einer bare Solution: `monoceros add-apt-packages --yes -- make openssh-client jq`                                  | Diff zeigt `features` mit `ghcr.io/devcontainers-contrib/features/apt-packages:1` und `packages: "jq,make,openssh-client"` (alphabetisch sortiert). `stack.json.aptPackages = ["jq", "make", "openssh-client"]`. Success-Output schließt mit Hinweis "Run \`monoceros apply\` to rebuild the container and pick up the change."                                                          | M2.5 Task 3  |
| B.20 | add-apt-packages idempotent     | Wiederholung von B.19 mit Reihenfolge `jq make openssh-client`                                                        | "No changes — solution is already in the desired state.", Exit 0, Files byte-identisch                                                                                                                                                                                                                                                                                                   | M2.5 Task 3  |
| B.21 | add-apt-packages akkumuliert    | nach B.19: `monoceros add-apt-packages --yes -- curl`                                                                 | Liste in `stack.json` wird zu `["curl", "jq", "make", "openssh-client"]`. `devcontainer.json` updated entsprechend                                                                                                                                                                                                                                                                       | M2.5 Task 3  |
| B.22 | add-apt-packages Shell-Schutz   | `monoceros add-apt-packages -- 'make; rm -rf /'`                                                                      | Error "Invalid apt package name: …", Exit 1                                                                                                                                                                                                                                                                                                                                              | M2.5 Task 3  |
| B.23 | add-apt-packages ohne `--`      | `monoceros add-apt-packages make`                                                                                     | Error "No package names given. Usage: …", Exit 1. Begründung: gleiche `--`-Konvention wie `monoceros run`                                                                                                                                                                                                                                                                                | M2.5 Task 3  |
| B.24 | add-feature mit Options         | `monoceros add-feature ghcr.io/devcontainers/features/docker-in-docker:2 --yes -- version=latest moby=true`           | Diff schreibt `features` mit `docker-in-docker:2` und Options `{ "version": "latest", "moby": true }` (Boolean richtig coerced — kein String "true"). `stack.json.features` enthält denselben Hash. Success-Output mit `apply`-Hinweis                                                                                                                                                   | M2.5 Task 4  |
| B.25 | add-feature ohne Options        | `monoceros add-feature ghcr.io/devcontainers/features/github-cli:1 --yes`                                             | Diff schreibt `features` mit leerem Options-Objekt `{}`. Idempotent: zweiter Aufruf → "No changes …"                                                                                                                                                                                                                                                                                     | M2.5 Task 4  |
| B.26 | add-feature Options-Konflikt    | nach B.24: `monoceros add-feature ghcr.io/devcontainers/features/docker-in-docker:2 --yes -- version=24`              | Error "Feature … is already configured with different options", Exit 1. Begründung: Builder soll Options-Änderung bewusst machen (stack.json editieren oder remove-feature, später)                                                                                                                                                                                                      | M2.5 Task 4  |
| B.27 | add-feature Ref-Validation      | `monoceros add-feature 'ghcr.io/foo; rm -rf /' --yes`                                                                 | Error "Invalid devcontainer feature ref …", Exit 1. Shell-Metacharacters werden nicht in features-Map durchgereicht                                                                                                                                                                                                                                                                      | M2.5 Task 4  |
| B.28 | add-feature Smart-Coercion      | `monoceros add-feature ghcr.io/devcontainers/features/node:1 --yes -- version=20 nvmInstallPath=/usr/local/share/nvm` | `version: 20` als Number coerced, `nvmInstallPath: "/usr/local/share/nvm"` bleibt String. Booleans (`true`/`false`), Integers, Strings werden getrennt erkannt                                                                                                                                                                                                                           | M2.5 Task 4  |
| B.29 | add-from-url einzelne URL       | in einer bare Solution: `monoceros add-from-url --yes https://example.com/install.sh`                                 | Diff zeigt: `post-create.sh` bekommt am Ende eine Sektion mit `bash <(curl -fsSL "https://example.com/install.sh")`. `stack.json.installUrls = ["https://example.com/install.sh"]`. Success-Output endet mit `apply`-Hinweis                                                                                                                                                             | M2.5 Task 5  |
| B.30 | add-from-url Order              | nach B.29: `monoceros add-from-url --yes https://example.com/extras.sh`                                               | `installUrls` wird `[".../install.sh", ".../extras.sh"]` (Insertion-Order, _nicht_ alphabetisch). `post-create.sh` führt install.sh _vor_ extras.sh aus                                                                                                                                                                                                                                  | M2.5 Task 5  |
| B.31 | add-from-url idempotent         | Wiederholung von B.29                                                                                                 | "No changes — solution is already in the desired state.", Exit 0                                                                                                                                                                                                                                                                                                                         | M2.5 Task 5  |
| B.32 | add-from-url Security-Warnung   | `monoceros add-from-url https://example.com/install.sh` (ohne `--yes`)                                                | Stderr enthält "⚠️ SECURITY WARNING" + URL + Hinweise (Browser-Audit, Maintainer-Verify, Vorschlag add-apt-packages/add-feature). Danach Confirm-Prompt, Antwort `n` → "Aborted by user", Exit 1                                                                                                                                                                                         | M2.5 Task 5  |
| B.33 | add-from-url Schema-Validation  | `monoceros add-from-url --yes http://example.com/install`                                                             | Error "Invalid install URL …", Exit 1 (kein `http://`)                                                                                                                                                                                                                                                                                                                                   | M2.5 Task 5  |
| B.34 | add-from-url Shell-Schutz       | `monoceros add-from-url --yes 'https://example.com/install$(whoami)'`                                                 | Error "Invalid install URL …" — Shell-Metacharacters werden _vor_ dem Schreiben in post-create.sh abgefangen                                                                                                                                                                                                                                                                             | M2.5 Task 5  |
| B.35 | add-repo Basis (HTTPS public)   | in einer bare Solution: `monoceros add-repo --yes https://github.com/foo/bar.git`                                     | Diff: `stack.json.repos = [{ url, name: "bar" }]`, `<solution>.code-workspace` bekommt zusätzlichen Folder-Root `{ path: "projects/bar", name: "bar" }`, `post-create.sh` bekommt `if [ ! -d "projects/bar" ]; then git clone … fi`-Block. Success endet mit `apply`-Hinweis                                                                                                             | M2.5 Task 6  |
| B.36 | add-repo --name + --branch      | `monoceros add-repo --yes --name=ui --branch=develop https://github.com/foo/bar.git`                                  | `stack.json.repos[0]` = `{ url, name: "ui", branch: "develop" }`. post-create.sh: `git clone --branch develop "https://github.com/foo/bar.git" "projects/ui"`. Workspace-File listet `projects/ui` als Root mit `name: "ui"`                                                                                                                                                             | M2.5 Task 6  |
| B.37 | add-repo Name-Derivation        | URL-Varianten: `git@github.com:foo/bar.git`, `https://github.com/foo/bar`, `ssh://git@github.com/foo/bar.git`         | Alle drei ergeben Name `bar` (Last-Segment, `.git` entfernt). Tests in `modify.test.ts → deriveRepoName` decken das deterministisch ab                                                                                                                                                                                                                                                   | M2.5 Task 6  |
| B.38 | add-repo idempotent             | Wiederholung von B.35                                                                                                 | "No changes — solution is already in the desired state.", Exit 0                                                                                                                                                                                                                                                                                                                         | M2.5 Task 6  |
| B.39 | add-repo Name-Kollision         | nach B.35: `monoceros add-repo --yes https://github.com/baz/bar.git` (anderer Org, gleicher Repo-Name)                | Error "Duplicate repo name: …. Each projects/<name> folder must be unique — pass --name to disambiguate.", Exit 1                                                                                                                                                                                                                                                                        | M2.5 Task 6  |
| B.40 | add-repo URL-Schutz             | `monoceros add-repo --yes 'https://github.com/foo/bar.git; rm -rf /'`                                                 | Error "Invalid repo URL …", Exit 1                                                                                                                                                                                                                                                                                                                                                       | M2.5 Task 6  |

**Fail-Bedeutung:**

- B.1–B.4 fehlerhaft → Generator hat einen Bug (siehe
  `packages/cli/src/create/scaffold.ts`)
- B.5/B.6 fehlerhaft → Idempotenz-Check in
  `packages/cli/src/create/index.ts` ist kaputt
- B.7/B.8 fehlerhaft → `validateOptions` lässt was durch, das nicht
  durchsollte
- B.9–B.12 fehlerhaft → Cwd-Awareness oder Compose-Resolution bricht
- B.13–B.40 fehlerhaft → Mutator-Logik in
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

Setup-Solution: dieselbe `sandbox`-Solution, die auch Stage E nutzt
(via `pnpm sandbox:reset` oder manuell):

```sh
mkdir -p .local/play && cd .local/play
monoceros create sandbox --languages=python --services=postgres
cd sandbox
```

| ID   | Was                                                 | Befehl                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Erwartet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Deckt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| C.1  | Compose-Lifecycle starten                           | `monoceros start`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `devcontainer up --workspace-folder …` läuft (nicht `docker compose up`). Image-Pull beim Erstaufruf, dann Build-Layer für Features (z. B. python), `postCreateCommand` läuft am Ende und installiert die Claude-CLI. Exit 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Task 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C.2  | Status zeigt Container                              | `monoceros status`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Tabelle: `workspace` und `postgres` jeweils mit State `running`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Task 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C.3  | Logs filterbar                                      | `monoceros logs --service=postgres --no-follow`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Postgres-Init-Log endet mit "database system is ready to accept connections"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Task 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C.4  | One-off-Run im Container                            | `monoceros run -- node --version`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Gibt Node-Version aus, Exit 0. `claude --version` gleich danach läuft sofort durch (CLI ist im Runtime-Image vorinstalliert, kein npm-Install im post-create mehr).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Task 5, 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C.5  | Exit-Code-Propagation                               | `monoceros run -- bash -c 'exit 7'; echo $?`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Letzte Zeile: `7`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Task 5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C.6  | Postgres aus dem Container erreichbar               | `monoceros run -- bash -c '(echo > /dev/tcp/postgres/5432) && echo "TCP reachable: postgres:5432"'`                                                                                                                                                                                                                                                                                                                                                                                                                                  | Output: `TCP reachable: postgres:5432`. Beweist: DNS für Hostname `postgres` löst innerhalb des Compose-Default-Networks auf, Port 5432 nimmt Verbindungen an. Geht durch obwohl Egress-Whitelist aktiv ist — RFC1918 ist unconditional erlaubt für Compose-interne Services.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Task 3, 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C.7  | Interaktive Shell                                   | `monoceros shell`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Drinnen: Prompt im Container, `whoami` → `node`, `pwd` → `/workspaces/sandbox`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Task 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C.8  | Auth-Pass-Through (Vorabprobe)                      | im `monoceros shell`: `claude --version`, dann `claude` (kurz Hello sagen, exit). Anschließend `monoceros stop && monoceros start && monoceros run -- claude --version`.                                                                                                                                                                                                                                                                                                                                                             | **macOS-Erstaufruf**: OAuth-Login im Container (Code aus Browser einfügen). Grund: Claude auf macOS speichert Credentials in der Keychain, die ist außerhalb des Containers nicht zugänglich — der Bind-Mount kann beim ersten Mal nichts mitbringen. **Folge-Aufrufe**: kein Login-Prompt mehr, weil der in-Container-Login `~/.claude/.credentials.json` in den Bind-Mount geschrieben hat und der nun persistiert. Der zweite `monoceros run -- claude --version` muss ohne Re-Auth durchlaufen. _Voller Auth-Smoke ist Task 10._                                                                                                                                                                                                                                                                                                                                                 | Task 2, 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| C.9  | Stop preserviert Volumes                            | `monoceros stop` dann `monoceros start` dann C.6 erneut                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | C.6 funktioniert wieder, ohne erneuten Init. Zeigt: `stop` (nicht `down`) lässt Volumes leben.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Task 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| C.10 | `monoceros apply` rebuildet nach `add-*` (compose)  | Vorbedingung: laufende `sandbox`-Solution (aus C.1). Host-seitig _vorher_ den Volume-Stempel notieren: `docker volume inspect sandbox_devcontainer_postgres-data --format '{{.CreatedAt}}'`. Dann: `monoceros add-language python --yes && monoceros apply`. Anschließend `monoceros run -- python3 --version`, `monoceros status` und host-seitig `docker volume inspect sandbox_devcontainer_postgres-data --format '{{.CreatedAt}}'` erneut.                                                                                      | `apply`-Output zeigt zuerst `Force-removing existing sandbox_devcontainer containers (volumes preserved)…` plus die Container-IDs die entfernt wurden, dann `Bringing devcontainer up at …` + `devcontainer up`-Output mit Feature-Build-Layer für Python. Nach `apply`: `python3 --version` antwortet mit `Python 3.x.y` (Feature ist im neuen Container — vor `apply` war Python nicht da). `monoceros status` zeigt `workspace` und `postgres` beide `running`. Volume-`CreatedAt`-Stempel ist vor und nach dem `apply` **identisch** → der Cleanup hat nur Container + Netzwerk entfernt, das Volume nicht angefasst, Postgres-Daten überleben den Rebuild. Image-Mode-Variante (separate bare Solution): `monoceros apply` ruft `devcontainer up --workspace-folder <root> --remove-existing-container`, alter Workspace-Container ist weg, neuer hat das hinzugefügte Feature. | M2.5 Task 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| C.11 | `monoceros add-apt-packages` + `apply` (end-to-end) | Vorbedingung: laufende `sandbox`-Solution. `monoceros run -- which psql` muss vorher `psql not found` ausgeben (Sanity-Check). Dann: `monoceros add-apt-packages --yes -- postgresql-client jq && monoceros apply`. Anschließend `monoceros run -- bash -c 'PGPASSWORD=postgres psql -h postgres -U postgres -c "SELECT 1;"'` und `monoceros run -- jq --version`.                                                                                                                                                                   | `add-apt-packages` diff zeigt das apt-packages-Feature mit `packages: "jq,postgresql-client"`, Success-Output endet mit Hinweis auf `monoceros apply`. Nach `apply`: psql-Query antwortet mit `1`, `jq --version` antwortet mit `jq-1.x`. Beweist: das apt-packages-Devcontainer-Feature installiert die Pakete bei `up`-Zeit, und nach `apply` sind sie im PATH. Postgres-Volume überlebt analog zu C.10 (per `docker volume inspect`-CreatedAt verifizieren falls Daten relevant).                                                                                                                                                                                                                                                                                                                                                                                                 | M2.5 Task 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| C.12 | `monoceros add-feature` + `apply` (end-to-end)      | Vorbedingung: laufende `sandbox`-Solution. `monoceros run -- which gh` muss vorher `gh not found` ausgeben (Sanity-Check). Dann: `monoceros add-feature ghcr.io/devcontainers/features/github-cli:1 --yes && monoceros apply`. Anschließend `monoceros run -- gh --version` und (optional) `monoceros run -- gh auth status` (gibt erwartungsgemäß einen „not logged in"-Hinweis, beweist aber dass das Binary da ist).                                                                                                              | `add-feature`-Diff zeigt das github-cli-Feature mit leerem Options-Objekt. Success endet mit `apply`-Hinweis. Nach `apply`: `gh --version` antwortet mit `gh version 2.x.y`. Beweist: ein Devcontainer-Feature, das _nicht_ über `add-language` oder `add-apt-packages` kuratiert ist, kommt durch die `add-feature`-Schnittstelle hoch und ist nach Rebuild aktiv. Image-Mode-Solution: analog, nur `apply` ruft `devcontainer up --remove-existing-container`.                                                                                                                                                                                                                                                                                                                                                                                                                     | M2.5 Task 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| C.13 | `monoceros add-from-url` + `apply` (end-to-end)     | Vorbedingung: laufende `sandbox`-Solution, plus `monoceros add-apt-packages --yes -- ca-certificates curl && monoceros apply` falls noch nicht da (`curl` ist nicht im Default-Image-Bestand). Sanity: `monoceros run -- which starship` muss `not found` ergeben. Dann: `monoceros add-from-url --yes https://starship.rs/install.sh && monoceros apply`. (Warum starship: kleines, schnell installierbares Tool, idempotent als Script.) Anschließend `monoceros run -- which starship` und `monoceros run -- starship --version`. | `add-from-url`-Diff zeigt: post-create.sh wächst um einen `curl -fsSL "https://starship.rs/install.sh"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | sh`-Block, stack.json.installUrls listet die URL. Beim `apply`: post-create.sh läuft, lädt + installiert starship. Danach: `which starship`→`/usr/local/bin/starship`, `starship --version`antwortet mit`starship 1.x.y`. Beweist: Remote-Code-Execution via add-from-url ist end-to-end funktional und reproduzierbar. Image-Mode: analog. **Sicherheitsnote im Test-Plan:** dieser Test verwendet eine öffentliche URL eines etablierten Projekts — keine Aussage über Eignung anderer URLs. | M2.5 Task 5 |
| C.14 | `monoceros add-repo` + `apply` (end-to-end)         | Vorbedingung: laufende `sandbox`-Solution. Sanity: `ls projects/` zeigt `.gitkeep` aber sonst leer. Dann (öffentliches Repo, klein): `monoceros add-repo --yes https://github.com/anthropic-experimental/anthropic-go-sdk-experimental.git` (oder eine andere kleine public-URL deiner Wahl) `&& monoceros apply`. Anschließend `monoceros run -- ls projects/` und `monoceros run -- bash -c 'cd projects/<name> && git log --oneline -3'`.                                                                                         | `add-repo`-Diff zeigt drei Dateien: `<solution>.code-workspace` (Folder-Root für `projects/<name>`), `stack.json.repos` (neue Entry), `post-create.sh` (Clone-Block). Nach `apply`: `ls projects/` listet den geklonten Folder. `git log --oneline -3` im Folder gibt die letzten drei Commits aus → echtes Repo gemounted. Re-Run von `monoceros apply` ohne `down`: kein Re-Klon, Output zeigt „projects/<name> already exists, skipping clone". Bei `down --volumes && start` analog (Bind-Mount überlebt — wird nur bei manuellem `rm -rf` der projects-Folder neu geklont).                                                                                                                                                                                                                                                                                                     | M2.5 Task 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

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
- C.10 fehlerhaft, mehrere Symptome:
  - `python3 --version` nicht gefunden nach `apply` → Feature wurde
    nicht eingebaut. Diagnose: `cat .devcontainer/devcontainer.json | jq .features` sollte
    `ghcr.io/devcontainers/features/python:1` enthalten; falls ja, hat
    der Rebuild den Layer übersprungen — `monoceros apply` erneut probieren.
  - Volume-`CreatedAt` ändert sich nach dem `apply` → der Cleanup hat
    doch Volumes mitgerissen. Das Bash-Script in
    [`runApply`](../packages/cli/src/devcontainer/compose.ts) macht
    `docker rm -f` (keine `-v`-Flag) und `docker network rm`; falls der
    Stempel trotzdem neu ist, prüf manuell ob `docker volume ls` das
    Volume noch listet.
  - `docker volume inspect sandbox_devcontainer_postgres-data` schlägt
    fehl mit „No such volume" → entweder Postgres ist nie hochgekommen
    (`monoceros status` zeigt nichts running) oder das Volume wurde
    durch ein `monoceros down --volumes` weggeräumt. Frische Solution:
    `pnpm sandbox:reset`.
  - `apply` scheitert mit „containers reappeared after removal" oder
    „container name … is already in use" → **VS Code mit aktiver
    Remote-Containers-Session** auf derselben Solution. Die
    VS-Code-Extension recreated den Container automatisch, sobald
    `apply` ihn entfernt — race mit dem nachfolgenden `devcontainer up`.
    Lösung: in VS Code `Cmd+Shift+P` → „Dev Containers: Close Remote
    Connection", danach `apply` erneut. Seit der Cleanup-Härtung
    erkennt `apply` das selbst (Post-Cleanup-Re-Check) und bricht mit
    eindeutigem Hinweis ab, statt in den Race-`up` zu laufen.
  - Image-Mode-Variante hängt → `--remove-existing-container` braucht
    @devcontainers/cli ≥ 0.86; check `node_modules/@devcontainers/cli/package.json`
    Version.
- C.11 fehlerhaft, mehrere Symptome:
  - `psql` schon vor `add-apt-packages` verfügbar → die Vorbedingung
    stimmt nicht, du hast `psql` bereits anderweitig installiert.
    Anderes Paket wählen oder mit frischer `pnpm sandbox:reset`-Solution
    arbeiten.
  - `apply` schreibt das Feature aber `psql` ist nach Rebuild nicht
    da → das apt-packages-Feature ist nicht angekommen. Diagnose:
    `monoceros run -- cat /var/log/dpkg.log | grep postgresql-client`
    sollte den Install zeigen. Falls leer: Feature-URL prüfen
    (`cat .devcontainer/devcontainer.json | jq .features`).
  - `apply` scheitert mit „Unknown feature" oder ähnlich → der
    Feature-Ref ist falsch geschrieben oder das Feature ist offline.
    Wir nutzen `ghcr.io/devcontainers-contrib/features/apt-packages:1`
    — die Community-Variante ist gepflegt, sollte erreichbar sein.
- C.12 fehlerhaft:
  - `gh` schon vor `add-feature` verfügbar → die Vorbedingung stimmt
    nicht (Image-Cache mit gh drin). Anderes Feature wählen
    (`docker-in-docker`, `kubectl-helm-minikube`, …) oder mit frischer
    `pnpm sandbox:reset`-Solution arbeiten.
  - `apply` zieht das Feature nicht → analog C.11: `cat .devcontainer/devcontainer.json | jq .features`
    muss den Eintrag zeigen. Falls ja, ist der Layer-Build evtl.
    übersprungen — manuell `monoceros down && monoceros start`.
  - `gh --version` antwortet aber wirft `command not found in PATH` →
    sehr selten, deutet auf ein Feature-Install-Skript-Problem hin.
    Diagnose: `monoceros run -- ls -la /usr/local/bin/gh` und
    `monoceros logs --service=workspace --no-follow | grep -i github-cli`.
- C.13 fehlerhaft:
  - `starship` schon vorhanden → Image-Cache, anderes Tool wählen oder
    `pnpm sandbox:reset`.
  - `curl: command not found` während `apply` → die `ca-certificates curl`-
    Vorbedingung wurde nicht erfüllt. Per `monoceros add-apt-packages
--yes -- ca-certificates curl && monoceros apply` nachholen.
  - `apply` läuft durch, aber `starship` ist trotzdem nicht installiert
    → das remote install-Skript ist fehlgeschlagen. Diagnose: in einer
    `monoceros shell` manuell `bash <(curl -fsSL https://starship.rs/install.sh)`
    laufen lassen — Fehler erscheinen dann direkt. Output von
    `monoceros logs --service=workspace --no-follow` kann auch helfen.
  - „SSL certificate problem" oder „connection refused" → Egress-
    Whitelist greift (default-off, sollte nicht). Prüfen:
    `MONOCEROS_EGRESS` Env-Var in compose.yaml.
- C.14 fehlerhaft:
  - `Permission denied (publickey)` beim Klon → SSH-Auth nicht
    konfiguriert. Bekanntes Limit (siehe `docs/commands/add-repo.md`
    → „Bekannte Limits"). Mit HTTPS-URL probieren, oder
    SSH-Agent-Mount händisch in `devcontainer.json` ergänzen.
  - `Repository not found` → URL falsch oder Repo privat. Public URL
    nutzen oder PAT-in-URL-Form (`https://USER:TOKEN@github.com/…`).
  - Folder `projects/<name>` wird bei jedem `apply` neu geklont → der
    Idempotenz-Check (`if [ ! -d … ]`) ist kaputt. Diagnose:
    `cat .devcontainer/post-create.sh` und prüfen, ob der Block
    syntaktisch ok ist.
  - `git: command not found` → der `git`-Layer im Default-Runtime-Image
    fehlt. Mit `monoceros add-apt-packages --yes -- git && monoceros apply`
    nachinstallieren (sollte aber nicht nötig sein — git ist Standard).

**Egress-Filter Hinweis:** der Runtime-Image-Entrypoint hat die
iptables-Allowlist-Mechanik weiterhin eingebaut, ist aber seit
2026-05-10 standardmäßig auf `off`. Setze
`MONOCEROS_EGRESS=enforce` im `compose.yaml`-`environment`-Block des
`workspace`-Service falls du den Filter für eine spezifische Solution
aktivieren willst (z. B. CI/Headless). Begründung in
[ADR 0002](adr/0002-egress-whitelist-runtime-image.md).

### Aufräumen Stage C (vom Workbench-Root):

```sh
# Container + Network + Volumes weg
cd .local/play/sandbox
monoceros down --volumes

# zurück und alles wegwerfen
cd ../../..
rm -rf .local/play
```

## Stage D — IDE-Integration (optional)

Manuelle Verifikation, dass die generierten Solutions in den drei
realistischen Nutzungspfaden funktionieren. Voraussetzung: eine
`sandbox`-Solution aus Stage C steht noch (`monoceros create sandbox --languages=python --services=postgres` falls nicht).

### D.1 — VS Code Dev Containers Standalone

**Voraussetzung:** VS Code mit der Extension `ms-vscode-remote.remote-containers`
("Dev Containers" von Microsoft).

**Aktion:**

1. Workspace-Folder in VS Code öffnen: `code .local/play/sandbox`
2. VS Code zeigt unten rechts „Folder contains a Dev Container
   configuration" → **Reopen in Container** (alternativ
   `Cmd+Shift+P` → „Dev Containers: Reopen in Container")
3. Beim ersten Mal: Container-Build/-Pull, kann mehrere Minuten dauern
4. Statusleiste zeigt „Dev Container: monoceros-default" (oder den
   Solution-Namen)
5. Terminal öffnen (`Ctrl+` ` `)

**Erwartet:**

- Prompt im Terminal: `node@<hash>:/workspaces/sandbox$`
- `whoami` → `node`
- `pwd` → `/workspaces/sandbox`
- `claude --version` → `2.1.138 (Claude Code)`
- Datei-Edits in VS Code spiegeln sich auf dem Host wider (Bind-Mount)

**Fail-Diagnose:** Container-Build hängt → `docker info` prüfen,
gegebenenfalls `pnpm image:build` nachziehen. Auth-Probleme im
Container → siehe C.8 (macOS-Keychain-Quirk).

### D.2 — Claude Code Extension im Dev Container

**Voraussetzung:** D.1 funktioniert, VS Code-Fenster ist im
Dev-Container-Mode.

**Aktion:**

1. Extensions-Panel öffnen (`Cmd+Shift+X`) → unter „Container" sollte
   `anthropic.claude-code` aufgeführt sein (wird durch
   `customizations.vscode.extensions` automatisch installiert)
2. Beim Erstaufruf: Extension lädt im Hintergrund, Status sichtbar
3. Claude-Code-Icon in der Activity Bar anklicken oder
   `Cmd+Shift+P` → „Claude: Open"
4. Einen kleinen Task absetzen: „lege eine `hello.txt` mit Inhalt
   `Hello from VS Code` an"

**Erwartet:**

- Extension auf-und-läuft, ist auth'd (gleiche `~/.claude`-Bind-Mount-
  Logik wie für die CLI; auf macOS einmalig OAuth, danach sticky)
- Task wird ausgeführt, `hello.txt` ist im Workspace sichtbar (sowohl
  in VS Code's File-Tree als auch auf dem Host: `cat
.local/play/sandbox/hello.txt`)

**Fail-Diagnose:** Extension fehlt → `customizations.vscode.extensions`
in der `devcontainer.json` der Solution prüfen. Extension nicht
authentifiziert → analog C.8 die OAuth-Flow im Container starten.

### D.3 — Claude Code im Terminal

Bereits durch C.7 + C.8 abgedeckt — `monoceros shell` öffnet bash,
`claude` ist preinstalliert und auth'd (nach Erst-Login auf macOS).
Hier nur als Cross-Reference; keine separaten Schritte.

### D.4 — Claude Desktop (erkundet)

**Status:** unklar wie der aktuelle Stand des Claude-Desktop-↔-
Devcontainer-Workflows ist. Claude Desktop läuft am Host; ob es eine
„open project in container"-Convention gibt oder ob man manuell ein
Terminal in den Container öffnen muss, weiß ich beim Schreiben des
Tests nicht. Erkunde:

1. Claude Desktop starten
2. Projekt-Navigation öffnen (UI-spezifisch)
3. Den Solution-Folder hinzufügen / öffnen
4. Eine kleine Aufgabe absetzen, schauen wo Claude Desktop sie
   ausführt — am Host oder im Container?

**Was wir damit lernen wollen:** ist Claude Desktop für unseren
Container-getriebenen Workflow nutzbar, oder ist die einzige sinnvolle
Kombination Claude-Desktop-am-Host + manueller `monoceros shell` für
container-bezogene Arbeit? Die Antwort dokumentieren wir hier nach
dem Erkundungs-Lauf.

## Was bewusst noch nicht abgedeckt ist

- Eigenes gehärtetes Runtime-Image, Multi-Arch via GHCR-Push → spätere Distributions-Etappe
- Cursor-Pfad — ausgeklammert, kein aktiver Einsatz
- Auth-Smoke auf zweitem Rechner → spätere Distributions-Etappe

## Historischer Stand (nicht mehr Teil dieser Workbench)

Ein „Stage E — M2 End-to-End: Plugin + Pipeline" Test-Block existierte
hier, solange die Iteration-Pipeline (Plan/Generate/Review) Teil der
Workbench war. Mit dem Pivot vom 2026-05-17 wurde dieser Code-Pfad
ausgelagert nach
`../monoceros-iterate_archive-2026-05-17/` — der Test-Block wandert
mit als `docs/test-plan-stage-e.md`. Wenn die Iteration-Pipeline
später als eigenes Projekt neu aufgesetzt wird, lebt dieser Test-Block
dort weiter.
