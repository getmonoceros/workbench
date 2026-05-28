# ADR 0010 — E2E-Tooling in eigenem Repo, maintainer-facing

- Status: accepted
- Datum: 2026-05-28

## Kontext

M5 Task 4 (ursprünglich „Test-Plan-Rewrite") wurde am 2026-05-28
umgewidmet zu einem automatisierten E2E-Testmodul (siehe Backlog).
Die Hand-Test-Anleitung in `docs/test-plan.md` ist gegen ein
längst überholtes CLI-Modell verdrahtet; eine Aktualisierung
Zeile-für-Zeile lohnt nicht.

Der naheliegende Gedanke wäre eine **GH-Actions-Matrix** gewesen,
die Linux / macOS / Windows parallel durchspielt. Das hat sich aus
mehreren Gründen als der falsche Hammer erwiesen:

- **macOS- und Windows-Runner haben Docker nicht out of the box.**
  Linux-Runner: Docker nativ, schnell. macOS: colima oder Docker
  Desktop via Brew installieren — 3-5 min Setup, fragil. Windows:
  Docker Desktop nur in bestimmten Runner-Images, Linux-Container-
  Mode muss umgeschaltet werden.
- **Die Bugs, die wir wirklich fangen wollen, sind plattform-
  spezifische Tooling-Quirks** (macOS Docker Desktop launchd-
  Sockets, Windows wincred, UTF-8 in PowerShell, EACCES auf
  privilegierten Ports unter Linux ohne CAP_NET_BIND_SERVICE).
  Die treten auf **echten** Maschinen auf, nicht in der bereinigten
  Runner-Umgebung.
- **Builder-Realität ≠ Runner-Realität.** Wer nachher Monoceros
  benutzt, hat es per `install.sh` / `install.ps1` auf seiner
  Maschine installiert, und ruft `monoceros …` von dort. CI-Runs
  in Sandbox-Containern simulieren das nicht.

## Verworfen: CI-Matrix-Sweep als Hauptpfad

Drei OSes × 5 Szenarien × Setup-Aufwand pro Run = sehr teuer, sehr
fragil, sagt am Ende wenig über die echte Builder-Experience aus.

## Entscheidung

Ein **maintainer-facing E2E-Tool**, das auf den drei realen
Builder-Maschinen läuft (Thorstens Linux-Rechner, Mac, Windows-
Laptop), Monoceros über die **public CLI-Schnittstelle** ansteuert
und ein definiertes Set von Szenarien durchspielt. Als Add-on zur
Workbench, nicht eingebaut.

### Repo-Trennung

Das Tool lebt in einem **eigenen Repo** (`getmonoceros/monoceros-e2e`,
finaler Name beim Anlegen). Drei Gründe:

1. **Schnittstellen-Kontrakt** — wenn das E2E-Tool im gleichen Repo
   wie der CLI-Code lebt, ist die Versuchung groß, interne Module
   zu importieren statt die CLI aufzurufen. Trennung erzwingt die
   Diszplin: das Tool kennt nur Subcommands, Argumente und
   Exit-Codes — exakt was ein Builder auch hat.
2. **Unabhängiger Release-Zyklus** — neue Szenarien können
   geshippt werden, ohne dass ein CLI-Release nötig ist.
3. **Klarheit** — das Workbench-Repo bleibt fokussiert auf das
   Produkt; das Tool, mit dem _wir_ es testen, ist eine separate
   Sache.

### Surface: `monoceros e2e <…>`

Trotz Repo-Trennung soll der Aufruf für den Maintainer **`monoceros e2e
<scenario>`** sein, nicht `monoceros-e2e <scenario>`. Eine Surface,
ein Mental-Model. Realisiert via **git-style Plugin-Discovery**:

- `monoceros` selbst kennt nur einen kleinen Dispatcher: wenn das
  erste Argument `e2e` ist und ein Binary `monoceros-e2e` im
  `PATH` liegt, werden die restlichen Argumente an das Binary
  durchgereicht.
- Existiert das Binary nicht: klare Fehlermeldung mit
  Install-Curl-Befehl.
- Die `__complete`-Engine bietet `e2e` als Subcommand an, wenn
  das Binary installiert ist (Detection via `which`/`where`).

Vorbild: `git foo` → `git-foo`, `kubectl plugin`-System.

### Installation

Analog zur Workbench: `install.sh` / `install.ps1`-Bouncer im E2E-
Repo, der das npm-Paket global installiert. Auf einer Workbench-
Installation:

```sh
# Linux / macOS
curl -fsSL https://getmonoceros.github.io/e2e/install.sh | bash

# Windows
iwr -useb https://getmonoceros.github.io/e2e/install.ps1 | iex
```

Update-Pfad: Skript erneut aufrufen.

### Szenarien

Initial fünf, geschrieben als TypeScript-Funktionen (volle Sprache,
beliebige Asserts) — _nicht_ als YAML/JSON-DSL. Die Asserts
variieren genug („TCP-Probe", „HTTP-200", „`docker ps -a` muss
leer sein nach remove"), dass eine DSL bald an Grenzen käme.

| Szenario            | Was es beweist                           | Zeit     |
| ------------------- | ---------------------------------------- | -------- |
| `minimal`           | init → apply → run → remove Lifecycle    | ~1 min   |
| `with-services`     | Compose + Service-Netzwerk via TCP-Probe | ~2 min   |
| `with-port`         | Traefik-Routing via Fixture-Repo + HTTP  | ~2 min   |
| `with-tunnel`       | TCP-Tunnel + Node-Probe vom Host         | ~2-3 min |
| `image-mode-zombie` | `remove` räumt Image-Mode-Container ab   | ~1.5 min |

Drei Mechanik-Entscheidungen:

- **Postgres-Reachability** in `with-services` wird via Bash-
  builtin `</dev/tcp/postgres/5432` geprüft, nicht via `psql`-Client.
  Sagt nur „TCP geht", spart aber den Tool-Footprint im Workspace.
- **HTTP-Probe** in `with-port` benutzt das vorhandene Fixture-Repo
  `getmonoceros/monoceros-e2e-fixture` (`serve-ports.mjs`), das
  genau für diesen Zweck angelegt wurde.
- **Tunnel-Probe** in `with-tunnel` ist ein TCP-Connect aus Node
  heraus, _nicht_ `psql` vom Host — vermeidet cross-OS-Host-Deps
  (apt / brew / scoop).

### Lifecycle pro Szenario

- Default: Setup → Asserts → Teardown (`monoceros remove --no-backup
--yes`).
- `--keep`: kein automatisches Remove, der Container bleibt für
  manuelle Inspektion stehen. Output zeigt den Container-Namen
  - Remove-Befehl.
- `--interactive`: nach den Asserts auf User-Bestätigung warten,
  bevor Remove läuft.
- Ctrl+C: alles bleibt stehen, kein Aufräum-Versuch. Inkonsistenter
  State wird beim **nächsten** Start abgeräumt.

### Pre-Flight-Cleanup

Container und yml-Profile, die die Szenarien anlegen, folgen einer
fixen Namenskonvention:

```
e2e-<scenario>-<YYYY-MM-DD-HHMM>
```

Beispiel: `e2e-minimal-2026-05-28-1830`. Vor jedem Test-Start
(egal ob einzeln oder via `--all`):

1. Liste `$MONOCEROS_HOME/container-configs/e2e-*.yml` → jeweils
   `monoceros remove --no-backup --yes <name>`.
2. Notbremse für Zombies, die `monoceros remove` nicht (mehr)
   kennt: `docker ps -aq --filter "name=^e2e-"` → `docker rm -f`.

Damit kann der Maintainer Ctrl+C jederzeit drücken, ohne State zu
korrumpieren — der nächste Aufruf räumt eh auf.

### Output-Format

- **Pretty-Print** (default) — farbig, mit Step-für-Step-Status,
  Timing pro Szenario.
- **GitHub-Annotations** wenn `GITHUB_ACTIONS=true` detected —
  `::error::` / `::notice::`-Marker, die im PR-UI als Inline-
  Annotation auftauchen.
- Kein JUnit-XML — kein Test-Aggregator in der Pipeline, der das
  konsumieren würde.

### CI-Integration

Smoketest-Job auf Linux-Runner only, läuft auf jedem main-Push und
PR (über die Reusable-Precheck-Mechanik bzw. als eigener Job).
Führt **nur das `minimal`-Szenario** aus — proof-of-life dass die
CLI baseline-funktional ist. macOS und Windows bleiben manuelle
Strecken auf den Builder-Maschinen.

Aufwand-Argument: Linux-Smoke ist ~1 min Runner-Zeit. macOS/Windows-
Smoketest würde 5-10 min Setup pro Run dazuholen und nur eine
Teilmenge der echten Builder-Quirks fangen. Schlechte Trade.

## Konsequenzen

- **Workbench-Repo bekommt minimal-invasive Änderungen**:
  Plugin-Dispatch (`commands/e2e.ts`, einige Zeilen) und ein
  optionaler Eintrag in der Completion-Spec. Ansonsten unverändert.
- **Neues Repo** `getmonoceros/monoceros-e2e` mit eigenem Release-
  Workflow, eigenem npm-Paket, eigenem install.sh/install.ps1.
- **Builder-OS-Coverage** entsteht über echte Maschinen, nicht
  über CI-Matrix. Das skaliert nicht beliebig, aber für drei OSes
  bei einem Maintainer ist es genau richtig.
- **Vorbild für künftige Tools**: wenn weitere maintainer-facing
  Tools auftauchen (z.B. `monoceros doctor` für Diagnose), ist das
  Muster „eigenes Repo, git-style Plugin" wiederverwendbar.
