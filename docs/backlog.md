# Monoceros Workbench — Backlog

Reihenfolge nach Milestones. Innerhalb eines Milestones sind die Tasks
in der Bauphase-Reihenfolge nummeriert. Erledigte Tasks bekommen ein
✅ vorgestellt und dürfen mit einem kurzen Hinweis auf das Ergebnis
ergänzt werden.

Konzeptioneller Überbau: [`konzept.md`](konzept.md).

---

## ✅ M0 — Bootstrap

**Ziel:** Das Repo ist arbeitsfähig — pnpm-Workspace, Linting,
Formatting, Husky, Basis-CI-Hygiene. Vor dem ersten Code-Commit von M1
abgeschlossen. **Abgeschlossen 2026-05-10.**

### Tasks

1. ✅ **pnpm-Workspace einrichten** — `pnpm-workspace.yaml` mit
   `packages/*` und `templates/*`. Root `package.json` mit
   `"type": "module"`, `"private": true`, Node-Engine ≥20.
2. ✅ **TypeScript-Basis** — `tsconfig.base.json` im Root mit strikter
   Konfig (strict, noUncheckedIndexedAccess, noImplicitOverride).
3. ✅ **Prettier + ESLint** — Versionen über Context7 prüfen, nicht aus
   Archiv kopieren. Flat-Config-Style. eslint-config-prettier zur
   Konflikt-Vermeidung.
4. ✅ **Husky + lint-staged** — `pre-commit` führt `lint-staged` aus.
   Gleiche Regeln wie im älteren Archiv: TS/JS/JSX → eslint --fix +
   prettier --write, JSON/MD/CSS/YAML → prettier --write.
5. ✅ **Vitest-Basis** — Root-Config, einzelne Pakete ziehen sie via
   `extends`. Mindestens ein Smoke-Test pro Paket.
6. ✅ **`.editorconfig` + `.gitignore` + `.gitattributes`** — aus dem
   Archiv übernehmen, wo sinnvoll. Zeilenenden auf LF, UTF-8.
7. **CI-Skeleton** — _erst wenn das Repo public oder remote-pushed
   wird._ GitHub-Actions-Workflow für Lint + Typecheck + Test. Im
   lokalen Mono-Repo-Stand vorerst optional.

### Definition of Done

- ✅ `pnpm install` läuft sauber
- ✅ `pnpm format:check` ist grün auf den Konzept-Dokumenten
- ✅ Ein leerer Commit triggert die husky pre-commit-Hooks ohne Fehler
- ✅ `pnpm typecheck` läuft (auch wenn noch keine Pakete TS-Code haben)

---

## M1 — DevContainer-CLI

**Ziel:** `monoceros create my-app` erzeugt einen lauffähigen
Devcontainer mit Linux + Docker + Claude Code, optionalen Services und
Sprach-Toolchains. `monoceros shell` führt nativ rein.

Schon nutzbar als Produkt _ohne_ M2: ein Builder kann manuell mit
Claude Code in einer abgesicherten Umgebung arbeiten — die strukturierte
Pipeline kommt dann mit M2 obendrauf.

**Bauplan (Reihenfolge):** CLI und Default-Template zuerst gegen ein
öffentliches Devcontainer-Base-Image; eigenes Runtime-Image kommt erst
am Ende, sobald CLI und Template stabil sind. Begründung in
[ADR 0001](adr/0001-m1-bauplan-cli-zuerst.md).

### Tasks

1. ✅ **CLI-Skeleton** — `packages/cli/` als `@monoceros/cli` mit
   [citty](https://github.com/unjs/citty) (entschieden gegen commander
   und clipanion: weniger Boilerplate, Inferenz aus `args`, jedes
   Command als Objekt direkt testbar). Alle neun Subcommands als Stubs
   registriert (`create`, `shell`, `run`, `logs`, `start`, `stop`,
   `status`, `add-service`, `add-language`), warnen via consola und
   exiten mit Code 2. Vitest-Smoke-Test prüft Metadaten + alle Commands.
   Root-Skript `pnpm cli` als Workspace-Wrapper.
2. ✅ **Default-Template** — `templates/default/.devcontainer/` mit
   `devcontainer.json` (Image
   `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm`,
   `remoteUser: node`, Bind-Mount `${localEnv:HOME}/.claude` →
   `/home/node/.claude`, `forwardPorts: [3000, 4000]`,
   `postCreateCommand: .devcontainer/post-create.sh`) und
   `post-create.sh` (installiert `@anthropic-ai/claude-code` global wenn
   nicht vorhanden, ruft `pnpm install` nur wenn `package.json`
   existiert). Compose-File bewusst noch nicht enthalten — kommt erst
   wenn `monoceros create` einen Service auswählt.
3. ✅ **`monoceros create` implementieren** — `runCreate` als reine
   Funktion in `packages/cli/src/create/`, vom Subcommand aufgerufen.
   Whitelist-Kataloge in [`catalog.ts`](../packages/cli/src/create/catalog.ts):
   Sprachen via Devcontainer-Features
   (`python|java|go|rust|dotnet`, `node` ist im Base-Image), Services
   als Compose-Stanzas (`postgres:18`, `mysql:8`, `redis:8`). Schreibt
   `.devcontainer/devcontainer.json` (Image-Mode ohne Services,
   Compose-Mode mit `dockerComposeFile`/`service`/`workspaceFolder`
   sobald Services aktiv), kopiert `post-create.sh` aus dem
   Default-Template, generiert `.devcontainer/compose.yaml` nur bei
   Bedarf, schreibt `.monoceros/stack.json` (Audit-Trail) und
   `README.md`-Stub. `--postgres-url` skippt den Compose-Postgres und
   landet als `externalServices.postgres` im stack.json. Idempotent:
   gleiche Optionen → no-op, abweichende Optionen → Refuse mit Hinweis
   auf `add-service`/`add-language`, non-empty Dir ohne stack.json →
   Refuse. 9 Vitest-Cases gegen tmp-dirs decken bare/languages/services/
   external-postgres/idempotent/conflict/non-empty/whitelist/name-validation
   ab.
4. ✅ **`monoceros shell` implementieren** — wrappt
   [`@devcontainers/cli`](https://github.com/devcontainers/cli) v0.86.1
   (als dep ins `@monoceros/cli` aufgenommen). `runShell` in
   [`packages/cli/src/devcontainer/shell.ts`](../packages/cli/src/devcontainer/shell.ts)
   ruft `devcontainer up --workspace-folder <root>` und anschließend
   `devcontainer exec --workspace-folder <root> bash` mit
   `stdio: 'inherit'`. Cwd-Awareness via
   [`findSolutionRoot`](../packages/cli/src/devcontainer/locate.ts)
   (walkt aufwärts nach `.devcontainer/`); `--project=<path>` als
   Override (relativ zur cwd oder absolut). Binary-Resolution über
   `createRequire` auf `@devcontainers/cli/package.json` → `node <bin>`,
   funktioniert unabhängig vom PATH. Up-Failure short-circuited mit
   propagiertem Exit-Code. 7 Vitest-Cases (Discovery + Orchestrator)
   gegen tmp-dirs mit injected Spawn-Fake.
5. ✅ **`monoceros run -- <cmd>`** — analog zu `shell`, non-interactive.
   `runInContainer` in
   [`packages/cli/src/devcontainer/run.ts`](../packages/cli/src/devcontainer/run.ts)
   nutzt denselben `up`-then-`exec`-Pfad wie `runShell`, leitet aber das
   Inner-Command verbatim an `devcontainer exec` weiter. Inner-Exit-Code
   wird durchpropagiert. citty würde `-la` als Flag interpretieren, also
   ist `--` Pflicht: `extractInnerCommand` zieht alles nach dem ersten
   `--` aus `rawArgs`; fehlt `--` oder ist die Slice leer, exitet das
   Command mit klarem Usage-Hinweis. 9 Vitest-Cases (parser + orchestrator)
   plus E2E-Smoke der Error-Pfade.
6. ✅ **`monoceros logs / start / stop / status`** —
   [`packages/cli/src/devcontainer/compose.ts`](../packages/cli/src/devcontainer/compose.ts).
   `resolveCompose` lokalisiert die Solution + `compose.yaml` und gibt
   bei Single-Image-Solutions (kein Compose) einen Hinweis auf
   `add-service` / `shell` aus statt blind zu rufen. `runStart` →
   `devcontainer up --workspace-folder <root>` (damit der Workspace-
   Container die `devcontainer.local_folder`-Labels bekommt, die
   anschließendes `monoceros run/shell` für die `exec`-Lookup braucht;
   `runServices` aus `devcontainer.json` zieht die Backing-Services mit
   hoch). `runStop` → `docker compose -p <solution>_devcontainer stop`
   (Volumes bleiben), `runStatus` → `… ps`, `runLogs` → `… logs -f`
   (Default; `--no-follow` für One-Shot). `--service=<name>` filtert
   stop/status/logs. Project-Name `-p <solution>_devcontainer` wird
   konsistent gesetzt, damit beide Pfade (compose-Passthrough und
   `devcontainer up` via `monoceros run/shell`) auf demselben Stack
   arbeiten. Geteilter `dispatch()`-Helper in
   [`commands/_dispatch.ts`](../packages/cli/src/commands/_dispatch.ts)
   übernimmt Exit-Code-Propagation und Error-Logging einmal für alle
   vier. 12 Vitest-Cases plus manueller E2E-Walkthrough.
7. ✅ **`monoceros add-service` / `add-language`** — gemeinsamer Mutator
   in [`packages/cli/src/modify/`](../packages/cli/src/modify/index.ts).
   Strategie: Stack lesen → Sprache/Service in den Optionen ergänzen →
   `devcontainer.json`, `compose.yaml`, `stack.json` komplett aus den
   `buildXxx`-Helfern in `create/scaffold.ts` neu generieren →
   Unified-Diff (`diff`-npm-Paket) gegen den Bestand zeigen → bestätigen
   → schreiben. Idempotent durch Konstruktion: gleiche Optionen
   ergeben byte-identische Files. `--yes` skippt den Prompt für Skripte.
   Image→Compose-Übergang fällt umsonst raus (erste `add-service` auf
   eine bare Solution baut `compose.yaml` und switcht
   `devcontainer.json` automatisch). `createdAt` aus der existierenden
   `stack.json` bleibt erhalten, `monocerosCliVersion` wird auf den
   aktuellen Wert gehoben. 11 Vitest-Cases (Add-Pfade, Idempotenz,
   Whitelist, Createdat-Preserve, Abort-Pfad, Diff-Output) plus
   E2E-Smoke verifiziert.
8. **Eigenes Runtime-Image mit Egress-Whitelist** — Kernmotivation: für
   den Use-Case „Claude Code läuft längere Zeit unbeobachtet" ist die
   Container-Isolation alleine nicht genug. Egress-Whitelist via
   iptables verhindert Daten-Exfiltration (kompromittierter Agent),
   typo-squatted-npm-Phone-Home und ungewollte Telemetrie. Das ist die
   _eigentliche_ Sicherheits-Differenzierung der Workbench, nicht nur
   nice-to-have.

   ✅ **8a — Dockerfile bauen + lokal testen.** Schmale Schicht über
   `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm` in
   [`images/runtime/`](../images/runtime/) (statt Full-Rebuild aus dem
   Archiv — die alte Runtime hatte keine Egress-Logik, nur die
   Base-Image-Konventionen waren übernommbar). Entrypoint setzt
   `iptables`-Rules in der `OUTPUT`-Chain auf Basis der
   [Default-Allowlist](../images/runtime/egress-allow.default.txt)
   (Anthropic, npm, GitHub, ghcr, Debian-Repos, PyPI), plus optionale
   `.monoceros/egress-allow.txt` aus dem Workspace. Default-Policy
   `DROP`, IPv6 komplett geblockt, anschließend Drop auf `node`-User
   via `gosu`. Drei Modi via `MONOCEROS_EGRESS`-Env (`enforce`/`warn`/`off`).
   Ohne `NET_ADMIN`-Cap loggt der Entrypoint Warnung und fällt auf
   unrestricted Egress zurück (kein silent fail-open). Architektur-
   Entscheidung in [ADR 0002](adr/0002-egress-whitelist-runtime-image.md).
   Lokal smoke-getestet: erlaubte Hosts erreichbar, nicht-erlaubte
   blockiert, Override-Datei greift, alle drei Modi funktionieren.

   **8b — Default-Template umstellen.** `templates/default/.devcontainer/devcontainer.json`
   zeigt auf `monoceros-runtime:dev` (lokales Tag), `compose.yaml`
   bekommt `cap_add: [NET_ADMIN]` für den `workspace`-Service.
   `post-create.sh` schrumpft, weil Claude-CLI bereits im Image ist.
   Test-Plan-Stage-C komplett gegen das neue Image durchlaufen.

   **8c — Publish (später, vor Public-Release / Multi-Builder).**
   Multi-Arch via `docker buildx` (amd64 + arm64),
   `ghcr.io/kamann/monoceros-runtime:dev` + `:YYYY-MM-DD`-Tag,
   GitHub-Actions-Workflow für reproducible builds. Default-Template
   zeigt nach Push auf den GHCR-Tag.

9. **Verifikation auf drei Pfaden** — Test, dass dasselbe Projekt
   funktioniert in: (a) VS Code Dev Containers, (b) Cursor, (c)
   Claude Code via direkter Docker-Anbindung. Wenn (c) wackelt, ist
   das ein Show-Stopper für die Zielgruppe.
10. **Auth-Smoke-Test** — neues Projekt aus Null, ohne API-Key in ENV,
    nur Bind-Mount-Auth: `claude` im Container muss out-of-the-box mit
    dem Host-Account arbeiten. Auf zwei verschiedenen Rechnern
    verifizieren wenn möglich.

### Definition of Done

- `monoceros create demo --services=postgres && cd demo && monoceros shell`
  geht in unter 60s durch, Container ist drin, Claude funktioniert
- Postgres im Compose-Setup läuft, ist von innen erreichbar
- Reset (`docker compose down -v`) räumt sauber auf
- Eigenes Runtime-Image mit aktiver Egress-Whitelist, lokal verfügbar
  (8a + 8b). Public-Push (8c) optional bis zum Public-Release

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
- **HTTPS-Content-Filter** — Egress-Whitelist (Task 8) blockiert nur
  _wohin_ Pakete gehen, nicht _was_. Eine HTTPS-Inspecting-Proxy-Komponente
  (mitmproxy o. Ä.) im Container-Netz kann zusätzlich Payloads
  inspizieren und Patterns blockieren (z. B. ausgehende `.env`-Inhalte,
  AWS-Keys, OpenAI-API-Keys). Eigene Architektur-Entscheidung — wo
  läuft der Proxy, wie verteilen wir das CA-Zert in den Container, wie
  kalibrieren wir Falsch-Positive. Erst sinnvoll, wenn Egress-Whitelist
  steht und sich als Praxis bewährt hat.
- **MCP-Server-Whitelist + Audit-Trail** — wenn die Iteration-Pipeline
  (M2) MCP-Server zulässt, brauchen wir Kontrolle: Liste erlaubter MCP-
  Binaries pro Solution, Audit-Log welche Tools/Args sie aufrufen,
  optional Confirmation-Hook für sensible Operations
  (`fs.write`, `network.fetch`). Orthogonal zum Image-Hardening,
  passt eher als Layer in die Plugin-Architektur.
- **E2E-Test-Suite für Stage C** — `packages/cli/test-e2e/` mit
  Vitest-Cases für `monoceros start/status/logs/run/stop` gegen einen
  echten Docker-Daemon. Hinter Env-Flag (`MONOCEROS_E2E=1`) gated, in
  separatem CI-Job mit Image-Pre-Pull. Heute manuell via
  [`docs/test-plan.md`](test-plan.md) abgedeckt; Automatisierung lohnt
  sich erst wenn das Repo Multi-Contributor wird oder M2 die
  Iteration-Pipeline auf den Stage-C-Pfad draufsetzt. C.7 (interaktive
  Shell) und C.8 (Auth-Pass-Through) bleiben manuell — Auth braucht
  echten Anthropic-Account, nicht in CI darstellbar.
- **Visual-Discipline / Stack-Migration / Multi-Doc-Input** — Punkte
  aus dem Vorgänger-Backlog, die für die Workbench-Welt teils anders
  liegen. Bei Bedarf neu durchdenken.
