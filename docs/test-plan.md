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
monoceros --help           # Listing aller 11 Subcommands
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

| ID  | Was                             | Befehl                         | Erwartet                                                                                                                | Deckt     |
| --- | ------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| A.1 | Alle 11 Subcommands registriert | `monoceros --help`             | Listing mit `create`, `shell`, `run`, `logs`, `start`, `stop`, `down`, `status`, `apply`, `add-service`, `add-language` | Task 1    |
| A.2 | Versionsangabe stimmt           | `monoceros --version`          | `0.1.0-dev`                                                                                                             | Task 1    |
| A.3 | `create`-Args sichtbar          | `monoceros create --help`      | Args: `name` (positional), `--languages`, `--services`, `--postgres-url`                                                | Task 1, 3 |
| A.4 | `logs`-Args sichtbar            | `monoceros logs --help`        | Args: `--project`, `--service`, `--follow`                                                                              | Task 1, 6 |
| A.5 | `add-service`-Args sichtbar     | `monoceros add-service --help` | Args: `service` (positional), `--project`, `--yes`/`-y`                                                                 | Task 1, 7 |

**Fail-Bedeutung:** wenn A.1 nicht alle 11 zeigt, ist die
Subcommand-Registrierung in `packages/cli/src/main.ts` kaputt.

## Stage B — Scaffolding (kein Docker)

Arbeitsverzeichnis: `<workbench>/.local/play/`. Alle Befehle relativ
dazu.

```sh
mkdir -p .local/play && cd .local/play
```

| ID   | Was                             | Befehl                                                                               | Erwartet                                                                                                                                                                                                                                                                                                                                                                                 | Deckt        |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| B.1  | Bare-Solution (Image-Mode)      | `monoceros create demo`                                                              | Verzeichnis `demo/` mit `.devcontainer/devcontainer.json` (`image: monoceros-runtime:dev`, `runArgs: ["--cap-add=NET_ADMIN"]`, kein `dockerComposeFile`), `.devcontainer/post-create.sh` (executable, nur `pnpm install`), `.monoceros/stack.json`, `README.md`, `projects/.gitkeep` (leeres `projects/`-Verzeichnis), `demo.code-workspace` (Inhalt `{ "folders": [{ "path": "." }] }`) | Task 2, 3, 8 |
| B.2  | Sprach-Feature                  | `monoceros create demo-py --languages=python`                                        | `devcontainer.json` enthält `features: { "ghcr.io/devcontainers/features/python:1": {} }`                                                                                                                                                                                                                                                                                                | Task 3       |
| B.3  | Compose-Mode mit Services       | `monoceros create demo-svc --services=postgres,redis`                                | `devcontainer.json` ohne `image`, dafür `dockerComposeFile: "compose.yaml"` + `service: workspace` + `workspaceFolder: /workspaces/demo-svc`. `compose.yaml` mit `workspace` (`image: monoceros-runtime:dev`, `cap_add: [NET_ADMIN]`), `postgres:18`, `redis:8`                                                                                                                          | Task 3, 8    |
| B.4  | External Postgres               | `monoceros create demo-ext --services=postgres --postgres-url=postgres://example/db` | `stack.json` hat `services: []` und `externalServices.postgres: "postgres://…"`. Keine `compose.yaml`                                                                                                                                                                                                                                                                                    | Task 3       |
| B.5  | Idempotenz                      | `monoceros create demo` ein zweites Mal                                              | Info-Message "already initialized", Exit 0, keine Datei-Änderung                                                                                                                                                                                                                                                                                                                         | Task 3       |
| B.6  | Konflikt                        | `monoceros create demo --languages=python` (vorher ohne)                             | Error, Exit 1, Hinweis auf `add-service` / `add-language`                                                                                                                                                                                                                                                                                                                                | Task 3       |
| B.7  | Whitelist                       | `monoceros create x --languages=cobol`                                               | Error "Unknown language: cobol. Known: …"                                                                                                                                                                                                                                                                                                                                                | Task 3       |
| B.8  | Path-Traversal blocked          | `monoceros create ../escape`                                                         | Error "Invalid solution name"                                                                                                                                                                                                                                                                                                                                                            | Task 3       |
| B.9  | Status ohne Solution            | (Workbench-Root, also außerhalb von Solutions) `monoceros status`                    | Error "No .devcontainer/ found at or above …"                                                                                                                                                                                                                                                                                                                                            | Task 6       |
| B.10 | Status ohne Compose             | `cd .local/play/demo && monoceros status`                                            | Error "No compose.yaml … require services configured via add-service. Use monoceros shell …"                                                                                                                                                                                                                                                                                             | Task 6       |
| B.11 | Run ohne `--`                   | `monoceros run` (irgendwo)                                                           | Error "No command provided. Usage: monoceros run … -- \<cmd\>"                                                                                                                                                                                                                                                                                                                           | Task 5       |
| B.12 | Run mit `--` außerhalb Solution | (Workbench-Root) `monoceros run -- ls`                                               | Error "No .devcontainer/ found …" (nicht "no command")                                                                                                                                                                                                                                                                                                                                   | Task 5       |
| B.13 | add-language fügt Feature an    | in einer bare Solution: `monoceros add-language python --yes`                        | Diff-Preview zeigt `+ "ghcr.io/devcontainers/features/python:1": {}`, danach "✔ Updated solution"; `devcontainer.json` enthält `features`-Eintrag, `stack.json.languages` = `["python"]`                                                                                                                                                                                                 | Task 7       |
| B.14 | add-language idempotent         | Wiederholung von B.13                                                                | "No changes — solution is already in the desired state.", Exit 0, Files unverändert                                                                                                                                                                                                                                                                                                      | Task 7       |
| B.15 | add-language Whitelist          | `monoceros add-language cobol`                                                       | Error "Unknown language: cobol …", Exit 1                                                                                                                                                                                                                                                                                                                                                | Task 7       |
| B.16 | add-service Image→Compose       | in einer bare Solution: `monoceros add-service postgres --yes`                       | Diff: `devcontainer.json` switcht von `image:` auf `dockerComposeFile`+`service:workspace`+`runServices:[postgres]`; `compose.yaml` neu mit `workspace`+`postgres:18`; `stack.json.services`=`[postgres]`                                                                                                                                                                                | Task 7       |
| B.17 | add-service idempotent          | Wiederholung von B.16                                                                | "No changes — solution is already in the desired state.", Exit 0                                                                                                                                                                                                                                                                                                                         | Task 7       |
| B.18 | add-service ohne `--yes`        | `monoceros add-service redis` (Prompt mit `n` beantworten)                           | Diff angezeigt, dann Prompt "Apply these changes?", Antwort `n` → "Aborted by user. No files were written.", Exit 1, Solution unverändert                                                                                                                                                                                                                                                | Task 7       |

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

| ID  | Was                                   | Befehl                                                                                                                                                                   | Erwartet                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Deckt     |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| C.1 | Compose-Lifecycle starten             | `monoceros start`                                                                                                                                                        | `devcontainer up --workspace-folder …` läuft (nicht `docker compose up`). Image-Pull beim Erstaufruf, dann Build-Layer für Features (z. B. python), `postCreateCommand` läuft am Ende und installiert die Claude-CLI. Exit 0.                                                                                                                                                                                                                                                                                                        | Task 6    |
| C.2 | Status zeigt Container                | `monoceros status`                                                                                                                                                       | Tabelle: `workspace` und `postgres` jeweils mit State `running`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Task 6    |
| C.3 | Logs filterbar                        | `monoceros logs --service=postgres --no-follow`                                                                                                                          | Postgres-Init-Log endet mit "database system is ready to accept connections"                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Task 6    |
| C.4 | One-off-Run im Container              | `monoceros run -- node --version`                                                                                                                                        | Gibt Node-Version aus, Exit 0. `claude --version` gleich danach läuft sofort durch (CLI ist im Runtime-Image vorinstalliert, kein npm-Install im post-create mehr).                                                                                                                                                                                                                                                                                                                                                                  | Task 5, 8 |
| C.5 | Exit-Code-Propagation                 | `monoceros run -- bash -c 'exit 7'; echo $?`                                                                                                                             | Letzte Zeile: `7`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Task 5    |
| C.6 | Postgres aus dem Container erreichbar | `monoceros run -- bash -c '(echo > /dev/tcp/postgres/5432) && echo "TCP reachable: postgres:5432"'`                                                                      | Output: `TCP reachable: postgres:5432`. Beweist: DNS für Hostname `postgres` löst innerhalb des Compose-Default-Networks auf, Port 5432 nimmt Verbindungen an. Geht durch obwohl Egress-Whitelist aktiv ist — RFC1918 ist unconditional erlaubt für Compose-interne Services.                                                                                                                                                                                                                                                        | Task 3, 6 |
| C.7 | Interaktive Shell                     | `monoceros shell`                                                                                                                                                        | Drinnen: Prompt im Container, `whoami` → `node`, `pwd` → `/workspaces/demo`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Task 4    |
| C.8 | Auth-Pass-Through (Vorabprobe)        | im `monoceros shell`: `claude --version`, dann `claude` (kurz Hello sagen, exit). Anschließend `monoceros stop && monoceros start && monoceros run -- claude --version`. | **macOS-Erstaufruf**: OAuth-Login im Container (Code aus Browser einfügen). Grund: Claude auf macOS speichert Credentials in der Keychain, die ist außerhalb des Containers nicht zugänglich — der Bind-Mount kann beim ersten Mal nichts mitbringen. **Folge-Aufrufe**: kein Login-Prompt mehr, weil der in-Container-Login `~/.claude/.credentials.json` in den Bind-Mount geschrieben hat und der nun persistiert. Der zweite `monoceros run -- claude --version` muss ohne Re-Auth durchlaufen. _Voller Auth-Smoke ist Task 10._ | Task 2, 4 |
| C.9 | Stop preserviert Volumes              | `monoceros stop` dann `monoceros start` dann C.6 erneut                                                                                                                  | C.6 funktioniert wieder, ohne erneuten Init. Zeigt: `stop` (nicht `down`) lässt Volumes leben.                                                                                                                                                                                                                                                                                                                                                                                                                                       | Task 6    |

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
cd .local/play/demo
monoceros down --volumes

# zurück und alles wegwerfen
cd ../../..
rm -rf .local/play
```

## Stage D — IDE-Integration (optional)

Manuelle Verifikation, dass die generierten Solutions in den drei
realistischen Nutzungspfaden funktionieren. Voraussetzung: eine
Solution mit Services existiert (`monoceros create demo --languages=python --services=postgres`, analog zur Stage-C-Setup-Solution).

### D.1 — VS Code Dev Containers Standalone

**Voraussetzung:** VS Code mit der Extension `ms-vscode-remote.remote-containers`
("Dev Containers" von Microsoft).

**Aktion:**

1. Workspace-Folder in VS Code öffnen: `code .local/play/demo`
2. VS Code zeigt unten rechts „Folder contains a Dev Container
   configuration" → **Reopen in Container** (alternativ
   `Cmd+Shift+P` → „Dev Containers: Reopen in Container")
3. Beim ersten Mal: Container-Build/-Pull, kann mehrere Minuten dauern
4. Statusleiste zeigt „Dev Container: monoceros-default" (oder den
   Solution-Namen)
5. Terminal öffnen (`Ctrl+` ` `)

**Erwartet:**

- Prompt im Terminal: `node@<hash>:/workspaces/demo$`
- `whoami` → `node`
- `pwd` → `/workspaces/demo`
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
.local/play/demo/hello.txt`)

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

## Stage E — M2 End-to-End: Plugin + Pipeline (manuell)

Komplette Strecke von Null auf — Solution anlegen, Devcontainer
starten, Slash-Commands ausführen, Findings triagieren. Verifiziert
die M2-Tooling-Phase (Tasks 1–6).

**Voraussetzungen zusätzlich zu Stage C:**

| Was                                                  | Wozu                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install` _einmalig im Workbench-Root gelaufen_ | Pflicht. Liefert die Workspace-Symlinks unter `node_modules/`, die der Devcontainer per Bind-Mount sieht                                               |
| Linux-Platform-Binaries in `node_modules`            | Wird automatisch durch die `supportedArchitectures`-Config in `pnpm-workspace.yaml` mitgepullt — verifiziert via `ls node_modules/.pnpm \| grep linux` |
| Anthropic-Account / API-Key                          | Pipeline ruft echte Claude-API auf (Plan/Generate/Review-Phasen). Subscription oder API-Key reicht                                                     |

### Setup-Solution

```sh
mkdir -p .local/play && cd .local/play
monoceros create sandbox --languages=python --services=postgres
cd sandbox
```

**Schnellweg** beim wiederholten Stage-E-Durchlauf:

```sh
pnpm sandbox:reset
```

Das Skript rebuildet das Runtime-Image (`--no-cache`), bringt eine
vorhandene `sandbox`-Solution sauber runter, scaffoldet sie
frisch (`--languages=node --services=postgres`) und ruft
`monoceros start` auf. Source: [`scripts/sandbox-reset.sh`](../scripts/sandbox-reset.sh).
Idempotent — läuft auch sauber, wenn vorher gar nichts da war.

### E.1 — Sichtkontrolle vor dem Start

Erst die Files prüfen, ohne Docker.

| ID    | Was                                                | Befehl                                                                 | Erwartet                                                                                                                                                                 | Deckt                 |
| ----- | -------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| E.1.1 | Workbench-Bind-Mount in `devcontainer.json`        | `cat .devcontainer/devcontainer.json` (Image-Mode) bzw. `compose.yaml` | Eintrag mit absolutem Host-Pfad → `/opt/monoceros-workbench`, `type=bind`. Bei Compose: `- <abs>:/opt/monoceros-workbench:cached` im `workspace`-Service                 | Task 6 (Distribution) |
| E.1.2 | Solution-Verzeichnis **ohne** `.claude/commands/`  | `ls .claude/commands/` (sollte `No such file or directory` liefern)    | Slash-Commands liegen im Plugin-Paket; Claude Code lädt sie via Marketplace-Eintrag in `.claude/settings.json` — keine Kopien in der Solution                            | Task 6                |
| E.1.3 | `.claude/settings.json` registriert Marketplace    | `cat .claude/settings.json`                                            | Enthält `extraKnownMarketplaces.monoceros-workbench` mit `source: directory, path: /opt/monoceros-workbench` und `enabledPlugins["monoceros@monoceros-workbench"]: true` | Task 6                |
| E.1.4 | Marketplace-Manifest im Workbench                  | `cat ../../../.claude-plugin/marketplace.json`                         | Gültiges JSON mit `name: "monoceros-workbench"` und `plugins: [{ name: "monoceros", source: "./packages/plugin" }]`                                                      | Task 6                |
| E.1.5 | Plugin-Manifest im Workbench                       | `cat ../../../packages/plugin/.claude-plugin/plugin.json`              | Gültiges JSON mit `name: "monoceros"` und der erwarteten `description`                                                                                                   | Task 5                |
| E.1.6 | `post-create.sh` enthält `monoceros-plugin`-Wiring | `cat .devcontainer/post-create.sh`                                     | Sektion mit `/opt/monoceros-workbench/node_modules/.bin/tsx` und `/usr/local/bin/monoceros-plugin` (für den Bash-Entry der Slash-Commands)                               | Task 6                |

**Fail-Bedeutung:**

- E.1.1 fehlerhaft → `buildDevcontainerJson` / `buildComposeYaml`
  haben den Mount nicht eingefügt; `findRepoRoot()` greift evtl. nicht
- E.1.2 zeigt doch `.claude/commands/` → `copyPluginCommands` wurde
  versehentlich wieder in `monoceros create` aufgenommen (sollte
  raus sein); oder Solution ist ein Altstand vor dem cleanup
- E.1.3 fehlerhaft → `buildClaudeSettings()` wird nicht aufgerufen
  oder schreibt nach falschem Pfad. Settings-File ist Pflicht für
  CLI- _und_ VS-Code-Extension-Plugin-Loading.
- E.1.4 fehlerhaft → `.claude-plugin/marketplace.json` im Workbench
  fehlt oder ist syntaktisch kaputt. Ohne das funktioniert die
  `source: directory`-Auflösung nicht.
- E.1.5 fehlerhaft → Plugin-Manifest fehlt oder ist syntaktisch
  kaputt; `cat packages/plugin/.claude-plugin/plugin.json` host-seitig
  prüfen
- E.1.6 fehlerhaft → `templates/default/.devcontainer/post-create.sh`
  ist nicht aktualisiert

### E.2 — Container starten und Plugin-Verdrahtung verifizieren

```sh
monoceros start
```

Beim ersten Mal: Image-Pull + Postgres-Init + Python-Feature-Install.
Kann 1–3 Minuten dauern. Im `postCreateCommand` wird unser Symlink
gesetzt — schau, ob er da ist:

| ID    | Was                                  | Befehl                                                                            | Erwartet                                                                                                                                                                                                        | Deckt  |
| ----- | ------------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| E.2.1 | Workbench im Container sichtbar      | `monoceros run -- ls /opt/monoceros-workbench`                                    | Listing zeigt `packages/`, `templates/`, `docs/`, `node_modules/`, `pnpm-workspace.yaml` etc.                                                                                                                   | Task 6 |
| E.2.2 | `tsx` im Container ausführbar        | `monoceros run -- /opt/monoceros-workbench/node_modules/.bin/tsx --version`       | Versions-Output von tsx, **Exit 0**. Falls Fehler über fehlendes `@esbuild/linux-…`: die `supportedArchitectures`-Konfig hat host-seitig nicht gegriffen — `rm -rf node_modules pnpm-lock.yaml && pnpm install` | Task 6 |
| E.2.3 | `monoceros-plugin` in PATH           | `monoceros run -- which monoceros-plugin`                                         | `/usr/local/bin/monoceros-plugin`                                                                                                                                                                               | Task 6 |
| E.2.4 | Plugin-CLI antwortet                 | `monoceros run -- monoceros-plugin --help`                                        | Hilfetext mit Subcommands `iterate`, `list`, `triage`, `defer`. Exit 0                                                                                                                                          | Task 5 |
| E.2.5 | Plugin findet Solution-Root          | `monoceros run -- monoceros-plugin list`                                          | `No open items. Use \`--all\` to include triaged items.` — Pipeline ist noch nie gelaufen                                                                                                                       | Task 5 |
| E.2.6 | Plugin verweigert außerhalb Solution | `monoceros run -- bash -c 'cd /opt/monoceros-workbench && monoceros-plugin list'` | Error: `Not inside a Monoceros solution — no .monoceros/ or .devcontainer/ found from ... upwards.`                                                                                                             | Task 5 |

**Fail-Bedeutung:**

- E.2.1 leeres Listing → Bind-Mount wirkt nicht; Docker-Desktop-
  Datei-Sharing-Settings checken (macOS: das Workbench-Verzeichnis
  muss unter "File sharing" gelistet sein)
- E.2.2 fehlerhaft → `pnpm install` host-seitig hat `linux`-Platforms
  nicht gepullt. Diagnose: `ls node_modules/.pnpm | grep linux`
  zeigt sollte mindestens `@esbuild+linux-arm64` und `@esbuild+linux-x64`
- E.2.3 fehlerhaft → `post-create.sh` lief mit Fehler oder Symlink-
  Schreiben hat keine sudo-Rechte. Diagnose: `monoceros logs --service=workspace --no-follow | tail -30` zeigt post-create-Output
- E.2.5 falsche Antwort (Crash o. Ä.) → typischerweise ein Import-
  Fehler in `packages/plugin/src/`. Voll-Output via
  `monoceros run -- monoceros-plugin list 2>&1`

### E.3 — Erste echte Iteration via Slash-Command

Hier wird's _real_: Claude öffnen, `/iterate` ausführen, Pipeline
laufen lassen. **Zwei Wege**:

**Weg A — Claude Code im Terminal:**

```sh
monoceros shell
# im Container:
claude
```

In der Claude-Code-CLI dann `/monoceros:iterate "Add a CLI subcommand 'greet' that prints 'Hello'"`. Die Slash-Commands sind plugin-namespaced (Plugin heißt `monoceros`).

**Weg B — VS Code Claude-Code-Extension:**

`code .` host-seitig, „Reopen in Container", Extension öffnen, Slash-
Command in deren UI absetzen.

#### E.3.0 — Plugin-Installation (einmalig pro Builder-Maschine)

Beim ersten Start von Claude Code in einer Monoceros-Solution erkennt
Claude Code via `.claude/settings.json` einen unbekannten Marketplace
und stellt einen **Trust-Prompt**: Der Builder bestätigt das
Marketplace-Setup. Anschließend kopiert Claude Code das Plugin in
seinen Cache (`~/.claude/plugins/cache`) und aktiviert es per
`enabledPlugins`. Weil `~/.claude/` als Bind-Mount vom Host gemountet
ist, persistiert die Installation über Solution-Wechsel hinaus —
**einmaliger Schritt pro Builder-Maschine**, nicht pro Solution.

Falls Claude Code den Trust-Prompt nicht zeigt (z. B. weil der
Marketplace schon vorher mal akzeptiert wurde), kann die Installation
auch manuell getriggert werden:

```
/plugin install monoceros@monoceros-workbench
```

**Plugin-Update nach Workbench-Edits.** Plugin-Source wird gecached,
nicht live aus dem Bind-Mount gelesen. Wenn du am Plugin selbst
entwickelst (Slash-Command-MD oder `src/`-Files in
`packages/plugin/` ändern), brauchen die Änderungen ein:

```
/plugin update monoceros@monoceros-workbench
```

Das ist Claude Codes Konvention, kein Monoceros-Workaround.

In beiden Wegen prüfst du:

| ID    | Was                                            | Wie                                                                   | Erwartet                                                                                                                                                                                                                             | Deckt     |
| ----- | ---------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| E.3.1 | Slash-Command wird gefunden                    | `/mon<TAB>` in der Claude-Code-UI                                     | Autocomplete schlägt `/monoceros:iterate`, `/monoceros:findings`, `/monoceros:triage`, `/monoceros:defer` vor. Falls keines: Plugin nicht installiert (E.3.0) oder das Plugin lädt aus dem Cache nicht — siehe Fail-Bedeutung unten. | Task 5    |
| E.3.2 | Pipeline läuft alle drei Phasen                | `/monoceros:iterate "Add a CLI subcommand 'greet' that prints Hello"` | Output zeigt Phase-1 (Planner) → Phase-2 (Generator, Code-Edits) → Phase-3 (Reviewer). Mehrere Minuten möglich                                                                                                                       | Task 3, 5 |
| E.3.3 | Plugin-Output landet auf stdout                | Beobachten am Ende                                                    | Block in der Form: `Iteration <id>` + `recommendation: approve\|request_changes\|reject` + `tests: pass\|fail` + `rewound: yes\|no` + `appended: N findings, M concerns, K risks`                                                    | Task 5    |
| E.3.4 | Iteration-Audit geschrieben                    | `monoceros run -- ls .monoceros/iterations/`                          | Eine `<id>.json`-Datei. `cat` zeigt das vollständige `plan`/`generatorReport`/`reviewReport`-JSON                                                                                                                                    | Task 4, 5 |
| E.3.5 | Findings/Concerns/Risks geschrieben (bei `ok`) | `monoceros run -- ls .monoceros/{findings,concerns,risks}/`           | Mindestens ein Item irgendwo (typischerweise mehrere Concerns + Risks aus Planner/Generator)                                                                                                                                         | Task 4, 5 |
| E.3.6 | Code wurde tatsächlich geschrieben             | `monoceros run -- bash -c 'ls -la src 2>/dev/null \|\| ls'`           | Neue/geänderte Dateien sichtbar. AC vom Prompt erfüllt: das `greet`-Subcommand sollte irgendwo existieren                                                                                                                            | Task 3    |
| E.3.7 | Test-Run lief (falls Tests im Setup)           | Sichtbar in `cat .monoceros/iterations/*.json \| jq .testRun`         | `executed: true, passed: N>0, failed: 0` bei `approve`. Bei `request_changes`/`reject`: passend zu Findings                                                                                                                          | Task 3    |
| E.3.8 | Bei `reject`: File-Rewind tatsächlich erfolgt  | `git diff` host-seitig (Solution-Repo war vor `/iterate` clean)       | Workspace ist auf Pre-Generator-State zurückgesetzt. Im Audit `rewound: true`. Falls clean-Workspace _und_ `rewound: false`: File-Checkpointing hat nicht gegriffen — Symptom-Bug                                                    | Task 3    |

**Fail-Bedeutung:**

- E.3.1 fehlerhaft → Claude Code findet das Plugin nicht. Diagnose
  in dieser Reihenfolge:
  1. `cat .claude/settings.json` (E.1.3) — ist der Marketplace
     registriert und das Plugin aktiviert?
  2. `cat /opt/monoceros-workbench/.claude-plugin/marketplace.json`
     (E.1.4) — gültiges JSON, listet `monoceros`?
  3. `cat /opt/monoceros-workbench/packages/plugin/.claude-plugin/plugin.json`
     (E.1.5) — gültiges JSON, name = `monoceros`?
  4. Claude Code muss aus dem Solution-Root gestartet werden, sonst
     wird `.claude/settings.json` nicht gefunden.
- E.3.2 hängt → fehlende API-Auth. Diagnose: `claude --version` und
  versuche `claude` direkt im Container. OAuth-Erst-Login wie in C.8
- E.3.3 enthält Error → typischerweise SDK-API-Error. Diagnose:
  `cat .monoceros/iterations/*.json | jq .errorSummary`
- E.3.4 fehlt komplett → `runIterateCommand` ist nicht durchgelaufen;
  `pnpm test --filter @monoceros/plugin` host-seitig prüfen ob Logik
  intakt
- E.3.8 falsch → File-Checkpointing-Pfad in
  `packages/core/src/runtime/agent.ts` / `rewind.ts` debuggen

#### Reference iteration sequence

Diese fünf Prompts wurden am 2026-05-11/12 in einer einzelnen
Stage-E-Sitzung gegen einen bare `monoceros create sandbox --languages=node --services=postgres`-Workspace gefahren. Sie bauen
aufeinander auf — die Solution wächst von leer zu einer kleinen
Node-CLI mit fünf Subcommands plus shared Validation-Helper. Jeder
Prompt zielt auf einen anderen Aspekt der Pipeline. Beim Reset
einer Stage-E-Session reicht `rm -rf src` (oder eine neue
Solution); `.monoceros/` und der Devcontainer bleiben, damit du
keine fünf Minuten Build-Pipeline neu durchlaufen musst.

1. **Greenfield-Start** — verlangt der Pipeline ab, ein leeres
   Projekt _selbst_ zu strukturieren (Manifest, src-Layout, Konvention
   wählen):

   ```
   /monoceros:iterate Add a CLI subcommand 'greet' that prints 'Hello'
   ```

2. **Erweiterung mit Annahmen** — testet, ob der Planner
   Spezifikationslücken als explizite Risks markiert (was passiert
   bei `greet` ohne Argument? — nicht im Prompt spezifiziert):

   ```
   /monoceros:iterate Make the greet command accept a name argument: greet <name> prints Hello, <name>!
   ```

3. **Refactoring mit Regression-Schutz** — verlangt eine
   strukturelle Änderung (DRY) plus Regression-ACs, dass das alte
   Verhalten erhalten bleibt:

   ```
   /monoceros:iterate Add a 'goodbye <name>' subcommand. Make sure goodbye and greet share their argument-validation logic via a helper module.
   ```

4. **Nicht-determinismus + bedingte Helper-Nutzung** — Randomness
   macht den Reviewer's Live-Probes schwieriger; der Helper soll
   _bedingt_ genutzt werden (nur wenn Argument da ist), nicht
   unconditional:

   ```
   /monoceros:iterate Add a 'wave' subcommand that prints a random one of: 'Hi!', 'Hey!', 'Yo!'. Wave should reuse the existing name-validation helper if a name is provided, and print '<greeting>, <name>!' in that case.
   ```

5. **Unicode-Edge-Case** — `.toUpperCase()` macht z. B. `ß` → `SS`,
   ist locale-abhängig; soll als Reviewer-Concern hochpoppen oder
   im Plan als Risk markiert werden:

   ```
   /monoceros:iterate Add a 'shout' subcommand that prints the name in ALL CAPS, like 'HEY, ALICE!'. Make sure it handles non-ASCII characters (umlauts, accents) correctly.
   ```

Nach diesen fünf hat die Solution einen `src/cli.js`-Dispatcher mit
fünf Subcommands (`greet`, `goodbye`, `wave`, `shout` + einem aus
Iter 1) und einen `src/lib/validate-name.js`-Helper. Insgesamt
~10–15 Items unter `.monoceros/` als Material für Stage E.4.

**Reset für eine frische Stage-E-Session** (im Container, im
Solution-Root):

```sh
rm -rf src package.json package-lock.json node_modules
rm -rf .monoceros/findings .monoceros/concerns .monoceros/risks .monoceros/iterations
```

`stack.json` und `.devcontainer/` bleiben — Setup ist vollständig
erhalten, nur die Solution-Inhalte und das gesammelte
Material sind weg.

### E.4 — Triage-Workflow

Nachdem mindestens eine Iteration Items produziert hat:

| ID    | Was                                             | Befehl                                                       | Erwartet                                                                                                                                                        | Deckt  |
| ----- | ----------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| E.4.1 | `/monoceros:findings` listet offene Items       | In Claude Code: `/monoceros:findings`                        | Markdown-Liste gruppiert nach `## Findings/Concerns/Risks` mit Tag-Summary `(status, severity, category, blocking)` pro Eintrag                                 | Task 5 |
| E.4.2 | Direkt-CLI dasselbe Ergebnis                    | `monoceros run -- monoceros-plugin list`                     | Identische Ausgabe — die Slash-Command-`.md` ist nur ein dünner Wrapper                                                                                         | Task 5 |
| E.4.3 | Markdown-File für ein Item editierbar           | Solution `.monoceros/findings/<id>.md` öffnen im Host-Editor | Frontmatter mit `id`, `kind`, `status: "open"`, `severity`, `category`, `sourceIteration`, `createdAt` etc. Body = die Message                                  | Task 4 |
| E.4.4 | `/monoceros:triage <id> später` markiert        | In Claude Code: `/monoceros:triage <id-aus-E.4.1> später`    | Output: `<id> marked as später (was open).`                                                                                                                     | Task 5 |
| E.4.5 | Markdown-Diff sichtbar in git                   | `git diff .monoceros/`                                       | Nur die `status: "open"`-Zeile wurde durch `status: "später"` ersetzt; Body unverändert                                                                         | Task 4 |
| E.4.6 | `/monoceros:findings` zeigt das Item nicht mehr | `/monoceros:findings` erneut                                 | Triagiertes Item taucht nicht auf. `monoceros run -- monoceros-plugin list --all` zeigt es _doch_ mit `(später, …)`-Tag                                         | Task 5 |
| E.4.7 | `/monoceros:triage` mit unbekannter Status      | `/monoceros:triage <id> done`                                | Error: `Invalid triage status "done". Use one of: jetzt, später, verworfen.`                                                                                    | Task 5 |
| E.4.8 | `/monoceros:triage` mit unbekannter ID          | `/monoceros:triage doesnt-exist jetzt`                       | Error: `Item not found: doesnt-exist`                                                                                                                           | Task 5 |
| E.4.9 | `/monoceros:defer` schreibt manuellen Concern   | `/monoceros:defer "Auth-Layer braucht Rate-Limiting"`        | Neue `.monoceros/concerns/<timestamp>-<slug>.md` mit `sourceIteration: "manual"`, Output `Concern captured: <id>`. Taucht in nächstem `/monoceros:findings` auf | Task 5 |

### E.5 — Drei Iterationen + ehrliche Bewertung (Validation-Hypothese)

Nach Stage E.4 hast du eine erste Iteration vollständig verstanden.
Jetzt der echte Lakmus-Test: zwei weitere Iterationen am _selben_
Projekt, dann ehrlich bewerten (konzept.md → „Validierungs-Hypothesen
1+2").

```sh
# Iteration 2 (z. B. Erweiterung)
/iterate "Make the greet command accept a name argument: greet <name> → 'Hello, <name>!'"
# Iteration 3 (z. B. Bugfix oder Refactor)
/iterate "Add unit tests for the greet command and make it case-insensitive"
```

Nach den drei Iterationen:

| ID    | Frage (subjektiv, ehrlich)                                                                                       | Worauf achten                                                                                                               |
| ----- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| E.5.1 | Sind die 15–20 Items unter `.monoceros/{findings,concerns,risks}/` _wirklich_ triage-würdig? Oder Rauschen?      | Hypothese 1 aus konzept.md. Wenn Rauschen: das Side-Topic-These ist eine Illusion und M3 (Tracking-Adapter) hat keinen Sinn |
| E.5.2 | Wählt Claude Stack-Tooling sinnvoll? Tests im Test-Framework des Projekts, kein Drizzle in Python-Solution, etc. | Hypothese 2 aus konzept.md. Wenn nein: die Stack-agnostischen Prompts (Task 1) brauchen Schärfung                           |
| E.5.3 | War mindestens eine Iteration mit `recommendation: "reject"`? Wurde tatsächlich rewound?                         | Verifiziert File-Checkpointing in echtem Einsatz. Falls _alle_ ‹approve›: vielleicht ist der Reviewer-Prompt zu lasch       |
| E.5.4 | Hat Claude irgendwann _gelogen_ — Generator-Report sagt „tests grün, app läuft", aber App ist tot?               | Reaktivierungs-Trigger für die in „Vorgemerkt für später" liegende Orchestrator-Side Live-App-Probe (ehemals Task 6)        |
| E.5.5 | Wie ist das UX-Gefühl? Slash-Command schnell genug? Output verständlich? Triage zäh?                             | Input für M3-Priorisierung und für eine spätere Triage-TUI-Entscheidung                                                     |

**Output dieses Stages:** ein kurzes Bewertungs-Dokument (eigenständige
Notiz, nicht hier inline) mit den Antworten auf E.5.1–E.5.5. _Das_ ist
die Voraussetzung für M3-Start (siehe Backlog M3 Definition).

### Aufräumen Stage E (vom Workbench-Root):

```sh
cd .local/play/sandbox
monoceros down --volumes
cd ../../..
rm -rf .local/play
```

## Was bewusst noch nicht abgedeckt ist

- Eigenes gehärtetes Runtime-Image, Multi-Arch via GHCR-Push → M4
- Cursor-Pfad — ausgeklammert, kein aktiver Einsatz
- Auth-Smoke auf zweitem Rechner → M4
- Saubere Plugin-Distribution ohne Bind-Mount-Krücke → M4
- Orchestrator-Side Live-App-Probe → reaktivierbar via E.5.4-Befund
  (siehe „Vorgemerkt für später" im Backlog)
