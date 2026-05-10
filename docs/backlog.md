# Monoceros Workbench — Backlog

Reihenfolge nach Milestones. Innerhalb eines Milestones sind die Tasks
in der Bauphase-Reihenfolge nummeriert. Erledigte Tasks bekommen ein
✅ vorgestellt und dürfen mit einem kurzen Hinweis auf das Ergebnis
ergänzt werden.

Konzeptioneller Überbau: [`konzept.md`](konzept.md).

---

## M0 — Bootstrap

**Ziel:** Das Repo ist arbeitsfähig — pnpm-Workspace, Linting,
Formatting, Husky, Basis-CI-Hygiene. Vor dem ersten Code-Commit von M1
abgeschlossen.

### Tasks

1. **pnpm-Workspace einrichten** — `pnpm-workspace.yaml` mit
   `packages/*` und `templates/*`. Root `package.json` mit
   `"type": "module"`, `"private": true`, Node-Engine ≥20.
2. **TypeScript-Basis** — `tsconfig.base.json` im Root mit strikter
   Konfig (strict, noUncheckedIndexedAccess, noImplicitOverride).
3. **Prettier + ESLint** — Versionen über Context7 prüfen, nicht aus
   Archiv kopieren. Flat-Config-Style. eslint-config-prettier zur
   Konflikt-Vermeidung.
4. **Husky + lint-staged** — `pre-commit` führt `lint-staged` aus.
   Gleiche Regeln wie im älteren Archiv: TS/JS/JSX → eslint --fix +
   prettier --write, JSON/MD/CSS/YAML → prettier --write.
5. **Vitest-Basis** — Root-Config, einzelne Pakete ziehen sie via
   `extends`. Mindestens ein Smoke-Test pro Paket.
6. **`.editorconfig` + `.gitignore` + `.gitattributes`** — aus dem
   Archiv übernehmen, wo sinnvoll. Zeilenenden auf LF, UTF-8.
7. **CI-Skeleton** — _erst wenn das Repo public oder remote-pushed
   wird._ GitHub-Actions-Workflow für Lint + Typecheck + Test. Im
   lokalen Mono-Repo-Stand vorerst optional.

### Definition of Done

- `pnpm install` läuft sauber
- `pnpm format:check` ist grün auf den Konzept-Dokumenten
- Ein leerer Commit triggert die husky pre-commit-Hooks ohne Fehler
- `pnpm typecheck` läuft (auch wenn noch keine Pakete TS-Code haben)

---

## M1 — DevContainer-CLI

**Ziel:** `monoceros create my-app` erzeugt einen lauffähigen
Devcontainer mit Linux + Docker + Claude Code, optionalen Services und
Sprach-Toolchains. `monoceros shell` führt nativ rein.

Schon nutzbar als Produkt _ohne_ M2: ein Builder kann manuell mit
Claude Code in einer abgesicherten Umgebung arbeiten — die strukturierte
Pipeline kommt dann mit M2 obendrauf.

### Tasks

1. **Runtime-Image bauen** — `images/runtime/Dockerfile` auf Basis des
   Archivs (`apps/runner/Dockerfile` o.ä.). Inhalt: Linux-Basis, Node
   ≥20, pnpm, Claude-Code-CLI, sudo + non-root User, Egress-Whitelist
   übernommen. Bauen + lokal testen.
2. **Image publishen** — `ghcr.io/kamann/monoceros-runtime:dev` oder
   ähnlich. Tagging-Strategie: `:latest` + `:YYYY-MM-DD` für
   Reproduzierbarkeit. Multi-Arch (amd64 + arm64) wegen Apple Silicon.
3. **CLI-Skeleton** — `packages/cli/` mit
   [commander](https://github.com/tj/commander.js) oder
   [clipanion](https://mael.dev/clipanion/) (Versions-Stand via
   Context7). Subcommands als Stubs: `create`, `shell`, `run`, `logs`,
   `start`, `stop`, `status`, `add-service`, `add-language`.
4. **Default-Template** — `templates/default/.devcontainer/devcontainer.json`
   mit Bind-Mount von `~/.claude/`, postCreate-Script für
   `pnpm install`, Port-Forwards (3000/4000 als Default). Compose-File
   als optional, kommt nur rein wenn ein Service ausgewählt wurde.
5. **`monoceros create` implementieren** — Flags für `--languages`,
   `--services`, `--postgres-url` (External-DB-Escape-Hatch). Schreibt
   `.devcontainer/`, `.monoceros/stack.json` (Audit-Trail welche Optionen
   gewählt wurden), `README.md`-Stub. Devcontainer-Features für die
   Sprachen (`ghcr.io/devcontainers/features/python:1` etc.) aus
   Whitelist auswählen.
6. **`monoceros shell` implementieren** — wrappt
   [`@devcontainers/cli`](https://github.com/devcontainers/cli) (`devcontainer exec`).
   Cwd-Awareness: sucht aufwärts nach `.devcontainer/`. Container starten
   wenn nötig.
7. **`monoceros run -- <cmd>`** — analog zu `shell`, aber non-interactive,
   führt Befehl aus und kommt zurück. Exit-Code propagiert.
8. **`monoceros logs / start / stop / status`** — direkt auf Compose
   bzw. Docker-Daemon. Mit `--service=postgres` filterbar.
9. **`monoceros add-service` / `add-language`** — modifiziert
   `compose.yaml` bzw. `devcontainer.json` einer existierenden Solution.
   Idempotent, mit Diff-Preview vor Schreiben.
10. **Verifikation auf drei Pfaden** — Test, dass dasselbe Projekt
    funktioniert in: (a) VS Code Dev Containers, (b) Cursor, (c)
    Claude Code via direkter Docker-Anbindung. Wenn (c) wackelt, ist
    das ein Show-Stopper für die Zielgruppe.
11. **Auth-Smoke-Test** — neues Projekt aus Null, ohne API-Key in ENV,
    nur Bind-Mount-Auth: `claude` im Container muss out-of-the-box mit
    dem Host-Account arbeiten. Auf zwei verschiedenen Rechnern
    verifizieren wenn möglich.

### Definition of Done

- `monoceros create demo --services=postgres && cd demo && monoceros shell`
  geht in unter 60s durch, Container ist drin, Claude funktioniert
- Postgres im Compose-Setup läuft, ist von innen erreichbar
- Reset (`docker compose down -v`) räumt sauber auf
- Image ist publik verfügbar, README erklärt einmal das Setup

### Bewusst nicht in M1

- Iteration-Pipeline (kommt M2)
- Tracking-Adapter (kommt M3)
- TUI für irgendwas — alles bleibt CLI + Markdown
- Mehrere Devcontainer-Templates (default reicht; spezialisierte Templates
  kommen erst, wenn ein konkreter Anwendungsfall sie verlangt)

---

## M2 — Claude-Code-Plugin (P/G/R + lokales Findings-Storage)

**Ziel:** `/iterate <prompt>` läuft die Plan/Generate/Review-Pipeline im
Container, persistiert Findings/Concerns/Risks als Markdown-Files unter
`.monoceros/`. `/findings` und `/triage` machen das Material kuratierbar.

### Tasks

1. **`packages/core` extrahieren** — Iteration-Prompts (Planner,
   Generator, Reviewer) aus dem Archiv übernehmen, **Stack-agnostisch
   umschreiben**: keine Drizzle/Zod/Vite-Annahmen mehr, stattdessen
   „lies 3-5 repräsentative Files, identifiziere Conventions, folge
   ihnen". Architecture-Philosophy-Block bleibt 1:1.
2. **Schemas in `packages/core/schemas`** — `IterationPlan`,
   `GeneratorReport`, `ReviewReport` als Zod-Schemas (Single Source of
   Truth). Aus Archiv übernehmen, prüfen ob alle Felder noch passen.
3. **Orchestrator extrahieren** — die 3-Phasen-Sequenz aus
   `iteration-orchestrator.ts` ins `packages/core` portieren.
   DB-Persistenz raus, File-Append als Persistenz-Adapter rein. Multi-Turn
   in Phase 2 (`--resume <session_id>`) erhalten.
4. **`packages/adapter-local`** — implementiert ein einfaches
   `FindingsStore`-Interface: `appendFinding`, `appendConcern`,
   `appendRisk`, `listOpen`, `markStatus(id, jetzt|später|verworfen)`.
   Schreibt nach `.monoceros/findings/<timestamp>-<slug>.md` etc. mit
   YAML-Frontmatter (id, severity, status, source-iteration, …).
5. **`packages/plugin`** — Claude-Code-Plugin-Manifest. Slash-Commands:
   `/iterate <prompt>` (ruft Orchestrator), `/findings [--status=open]`,
   `/triage` (interaktiv pro Item: jetzt/später/verworfen), `/defer
"<text>"` (manuelles Capture).
6. **CLI-Bridge** — `monoceros iterate "<prompt>"` als CLI-Variante des
   Slash-Commands für Builder ohne Claude-Code-UI. Selber Code-Pfad,
   andere Trigger-Schicht.
7. **Live-App-Probe automatisiert** — der Reviewer probt heute
   `curl localhost:3000/...` von innerhalb des Containers. Aus dem
   Archiv den entsprechenden Block übernehmen, Container-internen Probe
   hinzufügen.
8. **Erste echte Solution damit bauen** — _eigene_ Solution, nicht
   Studio-Hummel-Demo. Etwas, das du wirklich brauchst. 3 Iterationen
   mindestens.
9. **Validation-Check nach Solution 1** — `.monoceros/findings/` öffnen,
   ehrlich bewerten: 15-20 echte Items mit Triage-Wert? Oder
   nichtssagende Stichworte? Entscheidung über M3-Start hängt davon ab.

### Definition of Done

- `/iterate "Add user-creation form to /signup"` durchläuft alle drei
  Phasen, schreibt Code-Änderungen, persistiert mind. einen Finding
- `/findings` listet die Items
- `/triage` markiert Items, die Markdown-File-Änderungen sind im git-Diff
  sichtbar
- Solution mit ≥3 Iterationen lebt und ist nutzbar

### Bewusst nicht in M2

- TUI für Triage (Markdown im Editor reicht erstmal)
- Multi-Solution-Aggregat-Sicht
- Cross-Solution-Patterns
- Externe Tracking-Anbindung — das ist M3

---

## M3 — Externe Tracking-Adapter

**Ziel:** Findings können in GitHub Issues / Jira / Notion / Linear
gespiegelt werden. Markdown-Files bleiben Source of Truth, der Adapter
synchronisiert.

Vor M3-Start: M2-Validation muss positiv sein (Findings-Backlog ist
real wertvoll, sonst hat M3 keinen Sinn).

### Tasks

1. **Adapter-Interface in `packages/core/adapters`** — abstrakte
   Schnittstelle: `pushFinding`, `updateFinding`, `pullStatus`,
   `mapTaxonomy` (lokale Severity → External-Label-Schema).
2. **Konfiguration in `.monoceros/config.yaml`** — pro Solution welcher
   Adapter aktiv ist, mit Auth-Token-Referenz (kein Token im Repo, nur
   ENV-Var-Name oder Keyring-Key).
3. **`packages/adapter-github`** — GitHub-Issues. OAuth oder
   Personal-Access-Token. Mapping: Finding → Issue, Severity → Label,
   Status → Open/Closed.
4. **`packages/adapter-jira`** — Jira Cloud (nicht Server). Issue-Key
   pro Finding, Status-Mapping über Workflow-Transitions. Den
   Jira-Hook aus dem älteren Archiv (`prepare-commit-msg` mit
   Branch-Issue-Key) reaktivieren — dann ergibt er wieder Sinn.
5. **`packages/adapter-notion`** — Notion-Database als Backlog. Page
   pro Finding, Properties für Severity/Status. Komplexer wegen
   Notion-API-Eigenarten.
6. **`packages/adapter-linear`** — Linear-Issue. Sehr nahe an GitHub
   strukturell.
7. **CLI-Befehle** — `monoceros sync push`, `monoceros sync pull`,
   `monoceros sync status`. Bidirektional mit Konflikt-Erkennung
   (lokales Markdown vs. extern geänderter Status).
8. **Adapter-Tests** — gegen Mock-APIs jeder Plattform plus mind. einen
   Live-Smoke-Test gegen einen echten Sandbox-Account pro Adapter.

### Definition of Done

- Pro Adapter: ein Finding pushen, drüben sehen, drüben Status ändern,
  zurück synchronisieren funktioniert
- Konflikt-Erkennung greift (Markdown auf „später", extern auf „done"
  → Diff-Anzeige + manuelle Resolution)
- Setup-Guide pro Adapter im README

### Bewusst nicht in M3

- Bi-direktionale Echtzeit-Sync (kein Webhook, nur explizites Push/Pull)
- Eigene Tracking-UI in der Workbench (extern bleibt extern)

---

## Vorgemerkt für später (jenseits M3)

Items die jetzt nicht eingeplant sind, aber bewusst getrackt:

- **Multi-Solution-Aggregat-View** — `monoceros backlog --all`, das
  konfigurierte Solution-Ordner durchsucht und Findings global zeigt.
  Sobald 4+ aktive Solutions zeigen, ob das wirklich Wert hat.
- **TUI für Triage** — Ink/Bubbletea, wenn Markdown-Strecke sich als
  zu zäh erweist.
- **Web-UI über `packages/core`** — wenn sich rausstellt, dass
  Backlog-Triage und Multi-Solution-Sicht in einer Browser-UI deutlich
  besser sind als im CLI/Editor. Form-Faktor 2 aus der Konzept-Debatte.
- **Brief-Coverage als Reviewer-Probe** — der Reviewer könnte
  zusätzlich messen: „welche Use-Cases aus dem Original-Brief sind
  demonstrierbar implementiert?" Als natürliche Progress-Metrik.
- **opencode-Integration** — sobald opencode stabil ist, ins Image
  ergänzen, parallel zu Claude Code.
- **Pre-Push-Hook reaktivieren** — sobald Tests existieren, `npm test`
  als pre-push wieder aktivieren.
- **Visual-Discipline / Stack-Migration / Multi-Doc-Input** — Punkte
  aus dem Vorgänger-Backlog, die für die Workbench-Welt teils anders
  liegen. Bei Bedarf neu durchdenken.
