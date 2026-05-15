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

## ✅ M1 — DevContainer-CLI

**Ziel:** `monoceros create my-app` erzeugt einen lauffähigen
Devcontainer mit Linux + Docker + Claude Code, optionalen Services und
Sprach-Toolchains. `monoceros shell` führt nativ rein. **Abgeschlossen
2026-05-11.**

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
8. **Eigenes Runtime-Image** — schmale Schicht über Microsoft-Base mit
   Claude-CLI preinstalled + Egress-Toolchain (iptables, gosu, Allowlist-
   Mechanik). Egress-Enforcement steht im Image bereit, ist aber seit
   2026-05-10 **per Default deaktiviert** (`MONOCEROS_EGRESS=off`):
   die Hostname-Snapshot-Mechanik kollidiert in der Praxis mit VS-Code-
   Dev-Containers (rotierende Microsoft-CDNs) und mit der Claude-Code-
   VS-Code-Extension (eigener Subprocess-Stack über
   `@anthropic-ai/claude-agent-sdk`, nicht über `/usr/local/bin/claude`).
   Begründung und Migrationspfad in
   [ADR 0002](adr/0002-egress-whitelist-runtime-image.md). Echter
   Schutzbedarf für unbeobachteten Claude kommt über separate Items
   („Audit-Log Egress" + „HTTPS-Forward-Proxy-Sidecar", siehe
   "Vorgemerkt für später").

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

   ✅ **8b — Default-Template umstellen.**
   [`BASE_IMAGE`](../packages/cli/src/create/catalog.ts) ist jetzt
   `monoceros-runtime:dev`. Generierte Image-Mode-`devcontainer.json`
   bekommt `runArgs: ["--cap-add=NET_ADMIN"]`, generierte
   Compose-Mode-`compose.yaml` bekommt `cap_add: [NET_ADMIN]` auf den
   `workspace`-Service und kein `user: node` mehr (das Image-Entrypoint
   dropt selbst via `gosu` vom root auf `node`).
   [`post-create.sh`](../templates/default/.devcontainer/post-create.sh)
   schrumpft auf nur noch `pnpm install` (Claude-CLI ist im Image).
   Tests aktualisiert (51 grün); E2E lokal durchgespielt mit
   `monoceros create demo --languages=python --services=postgres &&
monoceros start && monoceros run -- claude --version`. Egress
   verifiziert: `api.anthropic.com:443` und `postgres:5432` erreichbar,
   `example.com:443` und `cloudflare.com:443` blockiert. Test-Plan-C.10
   deckt das ab.

   **Multi-Arch-GHCR-Publish wird Teil von M4** — heute kein Block,
   weil Workbench-Builder selbst `pnpm image:build` ausführen.

9. ✅ **Verifikation auf den realen Nutzungspfaden** — am 2026-05-11
   end-to-end durchgegangen (Stage D im Test-Plan).
   - **VS Code Dev Containers Standalone**: funktioniert nach
     Egress-Default-off + Image-Rebuild. „Reopen in Container"
     bringt Workspace + Services hoch, Terminal im Container ist als
     `node` drin, Files werden bidirektional gespiegelt.
   - **Claude Code als VS Code-Extension**: durch
     `customizations.vscode.extensions: ["anthropic.claude-code"]`
     automatisch im Container installiert. Auth läuft analog zur
     Terminal-CLI über den `~/.claude`-Bind-Mount (einmaliger
     macOS-Keychain-OAuth-Flow, danach sticky).
   - **Claude Code im Terminal**: über `monoceros run -- claude …`
     oder `monoceros shell` bereits in Stage C bestätigt.
   - **Claude Desktop / Remote Control**: die claude.ai-URL klappt
     auf Smartphone (native App) und im Browser. Die Anthropic-
     Desktop-App öffnet die URL aktuell nicht selbst — Limitation
     der App, kein Container- oder Monoceros-Problem.
   - **Cursor**: bewusst ausgeklammert (kein aktiver Einsatz).

   Code-Outcome aus diesem Task: Auto-Install-Liste in
   `customizations.vscode.extensions` (`anthropic.claude-code`).

### Definition of Done

- ✅ `monoceros create demo --services=postgres && cd demo && monoceros start && monoceros run -- claude --version`
  geht durch, Workspace + Services laufen, Claude antwortet
- ✅ Postgres im Compose-Setup läuft, ist von innen via Hostname
  `postgres` erreichbar
- ✅ Reset über `monoceros down --volumes` räumt sauber auf
- ✅ Eigenes Runtime-Image lokal verfügbar (8a + 8b). Egress-
  Enforcement liegt im Image, ist aber **default-off** (siehe
  ADR 0002).
- ✅ VS Code Dev Container + Claude-Code-VS-Code-Extension
  reproduzierbar funktionsfähig (Task 9)

Multi-Arch-GHCR-Publish und Auth-Smoke auf einem zweiten Rechner
gehören zu **M4 (Go-Live)** — beides macht erst Sinn, wenn ein
realistischer Solution-Builder-Flow von außen gegen die Workbench
gefahren werden kann.

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

### Vorab-Notiz vor M2-Start (Stand 2026-05-11)

Die Task-Liste unten ist die ursprüngliche M2-Skizze aus 2026-05-10.
Was sich seit M1-Abschluss verändert hat und vor dem ersten Code-Commit
geklärt werden sollte:

**Lesereihenfolge zum Einstieg** (in dieser Reihenfolge):

1. [`docs/konzept.md`](konzept.md) Abschnitte „Strukturierte Iteration-
   Pipeline" und „Side-Topic-Memory"
2. Archiv-ADRs (nur lesen, nicht übernehmen):
   - [`../../monoceros-for-solution-builder_archive-2026-05-10/docs/adr/0008-3-phasen-iteration-pipeline.md`](../../monoceros-for-solution-builder_archive-2026-05-10/docs/adr/0008-3-phasen-iteration-pipeline.md)
   - [`../../monoceros-for-solution-builder_archive-2026-05-10/docs/adr/0011-prompt-architektur-daten-vs-system.md`](../../monoceros-for-solution-builder_archive-2026-05-10/docs/adr/0011-prompt-architektur-daten-vs-system.md)
   - [`../../monoceros-for-solution-builder_archive-2026-05-10/docs/adr/0012-iteration-broker-decoupling.md`](../../monoceros-for-solution-builder_archive-2026-05-10/docs/adr/0012-iteration-broker-decoupling.md)
3. Archiv-Code (Inventur, was übernehmbar ist):
   - [`iteration-prompts/`](../../monoceros-for-solution-builder_archive-2026-05-10/apps/api/src/lib/iteration-prompts/)
     — `planner.ts`, `generator.ts`, `reviewer.ts`, `shared.ts`,
     `code-examples.ts`, `index.ts`
   - [`iteration-orchestrator.ts`](../../monoceros-for-solution-builder_archive-2026-05-10/apps/api/src/lib/iteration-orchestrator.ts)
   - [`schemas/iteration-pipeline.ts`](../../monoceros-for-solution-builder_archive-2026-05-10/packages/shared/src/schemas/iteration-pipeline.ts)
   - [`iteration-archive.ts`](../../monoceros-for-solution-builder_archive-2026-05-10/apps/api/src/lib/iteration-archive.ts)
     — ist DB-Persistenz, **wird ersetzt**; nicht übernehmen, nur als
     Referenz für die Datenstruktur lesen

**Geänderter Kontext seit der ursprünglichen Skizze:**

- Egress-Filter ist default-off (ADR 0002). Claude im Container hat
  freies Internet — keine Allowlist-Sorgen für API-Calls aus der
  Pipeline.
- Runtime-Image `monoceros-runtime:dev` hat `claude` (Anthropic CLI)
  preinstalled. Die Orchestrator-Phasen können verlässlich auf
  `claude --print …` ausführen (oder via SDK, siehe Design-Frage).
- `monoceros run -- <cmd>` läuft als saubere Schale für Subprocess-
  Aufrufe in den Container, falls die Orchestrator-Steuerung von
  außerhalb stattfindet.
- Solution-Layout: `.monoceros/stack.json` existiert. Findings/Concerns/
  Risks kommen daneben als neue Sub-Folders, müssen mit dem
  `monoceros add-service`/`add-language`-Mutator koexistieren (der
  regeneriert heute nur `.devcontainer/` und `stack.json`, lässt
  alles andere unter `.monoceros/` in Ruhe — verifiziert vor
  Schreib-Operationen).
- VS-Code-Claude-Extension nutzt `@anthropic-ai/claude-agent-sdk`,
  nicht das `claude`-Binary (entdeckt bei M1 Stage D). Relevant für
  die Design-Frage unten.

**Design-Fragen, die VOR Task 1 entschieden werden sollten** (jeweils
mit ADR-Eintrag als Output):

1. ✅ **Claude-Invocation-Mechanismus** — entschieden 2026-05-11:
   `@anthropic-ai/claude-agent-sdk`, nicht `claude --print`. Grund:
   eingebautes JSON-Schema-Enforcement (`outputFormat`) ersetzt den
   manuellen Parse-und-Zod-Schritt aus dem Archiv, typed Tool-
   Whitelists, File-Checkpointing für „Reviewer rejected →
   rewind". Provider-Wechsel (opencode) ist explizit out-of-scope;
   stattdessen wird der SDK-Aufruf an einer Stelle in
   `packages/core` gekapselt. Details in
   [ADR 0003](adr/0003-claude-invocation-via-agent-sdk.md).
2. ✅ **Orchestrator-Standort** — entschieden 2026-05-11: läuft im
   Devcontainer, nicht am Host. Workbench-weite Invariante: am Host
   passiert nur Container-Steuerung (`monoceros create/shell/start/…`),
   keine inhaltliche Arbeit am Solution-Repo. Details in
   [ADR 0004](adr/0004-orchestrator-und-plugin-im-devcontainer.md).
3. ✅ **Plugin- vs. CLI-Primat** — entschieden 2026-05-11: das
   Claude-Code-Plugin ist der primäre und einzige Eingang in M2.
   `monoceros iterate` als CLI-Bridge ist out-of-scope und wandert
   in „Vorgemerkt für später", weil ein nachgezogener Wrapper über
   `monoceros run -- …` trivial ist, sobald das Plugin sich bewährt
   hat. Details in
   [ADR 0004](adr/0004-orchestrator-und-plugin-im-devcontainer.md).
4. ✅ **Findings-Schema-Sprache** — entschieden 2026-05-11: Zod-
   Schemas werden aus dem Archiv portiert, vor dem Übernehmen
   gegen die neue Konzept-Sprache geprüft. Anzupassen mindestens:
   `status: jetzt|später|verworfen` (Konzept-Sprache aus
   [`konzept.md`](konzept.md), nicht `open/closed`), `sourceIteration`
   als Referenz auf den Iteration-Audit-Trail, `severity` und
   `recommendation` direkt aus dem Archiv. Konkrete Feld-Inventur
   passiert inline mit M2 Task 2.

**Erster konkreter Code-Schritt** (sobald Design-Fragen geklärt):
Workspace-Paket `packages/core` anlegen (analog zu `packages/cli`:
`package.json`, `tsconfig.json`, `vitest.config.ts`,
`src/index.ts`). Erst leeres Gerüst, in pnpm-Workspace einhängen,
Vitest-Smoke-Test laufen, committen. Dann inkrementell die
iteration-prompts portieren.

### Tasks

1. ✅ **`packages/core` extrahieren** — Iteration-Prompts portiert und
   Stack-agnostisch umgeschrieben (Drizzle/Tailwind/shadcn-Annahmen
   raus, „lies Manifest-Files, identifiziere Conventions"-Modell
   rein). 12 Tests; siehe commit `4895d13`.
2. ✅ **Zod-Schemas** — `IterationPlan`, `GeneratorReport`,
   `ReviewReport` mit Zod 4 portiert; `z.toJSONSchema()`-Output
   verifiziert für die SDK-`outputFormat`-Verwendung; zwei
   Sprach-Anpassungen (`existing_requirement` statt `flow_requirement`,
   `infra`/`tests` statt `migration`). 14 Tests; commit `8701cb3`.
3. ✅ **Orchestrator extrahieren** — `runPhase()` als einzelner
   SDK-Touchpoint (commit `1b8372e`, 18 Tests) und
   `runIterationPipeline()` als 3-Phasen-Komposit mit Rewind-bei-reject
   (commit `ce3fc4e`, 16 Tests).
4. ✅ **`packages/adapter-local`** — FindingsStore-Interface in
   `@monoceros/core/persistence` + Markdown-Persistierung unter
   `.monoceros/{findings,concerns,risks}/<id>.md` plus
   JSON-Audit-Trail unter `.monoceros/iterations/<id>.json`. 26 Tests;
   commit `d6c8855`.
5. ✅ **`packages/plugin`** — Claude-Code-Plugin-Manifest +
   Slash-Commands `/iterate`, `/findings`, `/triage`, `/defer` + Node-CLI
   `monoceros-plugin` (citty-basiert) als gemeinsamer Bash-Entrypoint
   der Slash-Commands. 21 Tests; commit `41156ba`.
6. **Plugin-Distribution für Task 7** — drei Iterationen während des
   Stage-E-Walkthroughs am 2026-05-12 durchlaufen:
   1. Erste Version: `cp` der Slash-Commands ins solution-lokale
      `.claude/commands/`. Funktioniert für Terminal-CLI, ist aber
      Live-Reload-feindlich (jede Plugin-MD-Änderung braucht `cp`).
   2. Zweite Version: `claude`-Wrapper im Runtime-Image, der
      `--plugin-dir` automatisch setzt. Funktioniert für Terminal, **nicht**
      für die VS-Code-Extension (die ruft `claude` nicht über PATH auf).
   3. **Aktuelle Version (final):** Claude Codes offizielles Plugin-
      Marketplace-System nutzen. Workbench hat eine
      `.claude-plugin/marketplace.json` am Repo-Root. `monoceros create`
      schreibt `.claude/settings.json` in jede Solution mit
      `extraKnownMarketplaces` (source: directory, path:
      /opt/monoceros-workbench) plus
      `enabledPlugins["monoceros@monoceros-workbench"]: true`. Funktioniert
      identisch für Terminal-CLI und VS-Code-Extension (beide lesen aus
      `.claude/settings.json`). Beim ersten Solution-Start stellt
      Claude Code einen Trust-Prompt; Builder bestätigt einmal, das
      Plugin landet im Cache unter `~/.claude/plugins/cache/`. Weil
      `~/.claude/` host-bind-mounted ist, ist das ein einmaliger
      Schritt pro Builder-Maschine. Plugin-Edits in der Workbench
      benötigen `/plugin update monoceros@monoceros-workbench` —
      Claude Codes Konvention für Cache-Refresh, kein Monoceros-
      Workaround. Slash-Commands sind plugin-namespaced
      (`/monoceros:iterate` etc.). Tests in
      `packages/cli/test/create.test.ts`. M4 ersetzt die `source:
directory` durch `source: github` — siehe M4-Tasks.
7. **Erste echte Solution damit bauen** — _eigene_ Solution, nicht
   Studio-Hummel-Demo. Etwas, das du wirklich brauchst. 3 Iterationen
   mindestens.
8. **Validation-Check nach Solution 1** — `.monoceros/findings/` öffnen,
   ehrlich bewerten: 15-20 echte Items mit Triage-Wert? Oder
   nichtssagende Stichworte? Entscheidung über M3-Start hängt davon ab.

### Definition of Done

- `/iterate "Add user-creation form to /signup"` durchläuft alle drei
  Phasen, schreibt Code-Änderungen, persistiert mind. einen Finding
- `/findings` listet die Items
- `/triage` markiert Items, die Markdown-File-Änderungen sind im git-Diff
  sichtbar
- Solution mit ≥3 Iterationen lebt und ist nutzbar

**Bewusst nicht mehr in M2:** Orchestrator-Side Live-App-Probe als
deterministischer HTTP-Check zwischen Generator und Reviewer. Die
ursprüngliche Idee aus dem Archiv hatte Vite/Fastify-Ports hardgecodet
— stack-agnostisch ist sie nur sinnvoll baubar, wenn wir wissen,
welche Probe-Form in der Praxis Wert hat. Verschoben in „Vorgemerkt
für später" mit klarer Reaktivierungs-Bedingung.

### Bewusst nicht in M2

- TUI für Triage (Markdown im Editor reicht erstmal)
- Multi-Solution-Aggregat-Sicht
- Cross-Solution-Patterns
- Externe Tracking-Anbindung — das ist M3
- `monoceros iterate`-CLI-Bridge — Plugin ist der einzige Eingang
  (siehe [ADR 0004](adr/0004-orchestrator-und-plugin-im-devcontainer.md)).
  Falls später nachgezogen, als dünner Wrapper über `monoceros run --`.

---

## M2.5 — DevContainer-Pimps (Workspace-Komfort)

**Ziel:** Den Dev-Container von einer „lauffähigen Umgebung" zu einer
**vollständig deklarativen Solution-Workbench** ausbauen. Builder
deklariert was er braucht (Sprachen, apt-Pakete, Devcontainer-Features,
Custom-Installer, Git-Repos), Monoceros materialisiert das. Jeder
Container-Rebuild reproduziert exakt dieselbe Umgebung. Keine
verlorene „ich hab das mal manuell installiert"-Tooling.

Läuft parallel zur offenen M2-Design-Diskussion
([design-pivot-autonomous-iterate.md](design-pivot-autonomous-iterate.md))
und ist unabhängig von deren Ausgang.

**Stand 2026-05-15:** Phase 1+2 + die organisch hinzugekommene
Auth-Infrastruktur sind alle abgeschlossen. Phase 3 wurde nach Builder-
Feedback umkonzipiert — yml ist jetzt ein **wiederverwendbares Profil
außerhalb des Dev-Containers**, nicht eine Per-Container-Manifest-
Datei. Phase 4 wurde dadurch überflüssig (es gibt keine
„stack.json → yml"-Migration mehr im alten Sinn — die yml ist die
externe Quelle, der Stack im Dev-Container leitet sich aus ihr ab und
zeigt nur per `origin` zurück auf den yml-Namen).

### Workspace-Layout — Vorab-Entscheidung

Solution-Layout bekommt eine eigene Projekt-Ebene unter `projects/`,
damit System-Dotfolder (`.monoceros/`, `.devcontainer/`, `.claude/`)
nicht in den Review-Scope rutschen:

```
sandbox/                          ← Dev-Container-Workspace-Root
  .claude/                        ← System
  .devcontainer/                  ← System
  .monoceros/                     ← System (Audit)
  README.md
  sandbox.code-workspace          ← VS Code Multi-Root-Definition
  projects/                       ← Container für Projekte
    repo-a/                       ← geklont oder `git init`
    repo-b/
```

`sandbox.code-workspace` listet `"."` plus jeden Projekt-Subfolder
als Root. Pipeline arbeitet cwd-basiert: Builder `cd projects/repo-a`,
ruft `/monoceros:iterate`, Pipeline findet `.monoceros/` durch
Aufwärtswalk. Multi-Projekt ist „einfach mehrere Folder unter
`projects/`" — keine spezielle Monoceros-Logik nötig.

### ✅ Phase 1 — Imperative `add-*`-Befehle + `apply` (abgeschlossen)

Drei neue Befehle für die drei realen Installationsarten, plus
Git-Clone und kombinierter Rebuild-Step. **Alles geliefert.**

1. ✅ **`monoceros add-apt-packages <pkg> [<pkg> …]`**
   - Mehrfach-Args (apt-Pakete kommen in Bündeln)
   - Speichert Liste in `stack.json.aptPackages: string[]`
   - Schreibt Devcontainer-Feature
     `ghcr.io/devcontainers-contrib/features/apt-packages:1` mit
     akkumulierter Liste
   - Idempotent: Paket schon drin → no-op
   - Diff-Preview, `--yes` zum Skippen

2. ✅ **`monoceros add-feature <feature-ref> [--option key=value …]`**
   - Single-Arg + Options-Pairs
   - Beispiel:
     `monoceros add-feature ghcr.io/devcontainers/features/docker-in-docker:2 --option version=latest`
   - Schreibt direkt in `.devcontainer/devcontainer.json` →
     `features` mit dem Options-Hash
   - Spiegelung in `stack.json.features: { [ref]: options }`
   - Idempotenz: gleiche Ref vorhanden → error (Builder muss explizit
     `remove-feature` + neu adden, falls Options sich ändern sollen)

3. ✅ **`monoceros add-from-url <url>`**
   - Single-Arg
   - Beispiel:
     `monoceros add-from-url https://teamwork-graph.atlassian.com/cli/install`
   - Speichert URL in `stack.json.installUrls: string[]`
     (Reihenfolge erhalten — Installs können aufeinander aufbauen)
   - Erweitert `.devcontainer/post-create.sh` um einen Block, der pro
     URL `bash <(curl -fsSL <url>)` ausführt
   - **Security-Confirm**: Befehl zeigt _vor_ dem Schreiben einen
     lauten Hinweis „This will execute remote shell code at every
     container build. Trust this URL? [y/N]". `--yes` zum Skippen.
   - Idempotenz: URL schon drin → no-op

4. ✅ **`monoceros add-repo <url> [--name=<n>] [--branch=<b>]`**
   - Eintrag in `stack.json.repos: Array<{url, name, branch}>`
   - `name` aus URL abgeleitet (`bar.git` → `bar`), Override via
     `--name`
   - Klont **nicht sofort** — beim nächsten Container-Start klont
     `post-create.sh` was in `projects/<name>/` fehlt (idempotent;
     bestehende Verzeichnisse werden in Ruhe gelassen)
   - `--clone-now` als Opt-in für direkten Host-Klon
   - SSH-Agent-Forwarding wird im Default in `devcontainer.json`
     ergänzt (`mounts` mit `${env:SSH_AUTH_SOCK}`), damit Container-
     interne Git-Operationen ohne Host-Setup funktionieren
   - Aktualisiert `<solution>.code-workspace`: neuer Root für
     `projects/<name>/`

5. ✅ **`monoceros apply`** (neuer Befehl)
   - Kombiniert Container-Teardown (Label-basiert, mit VS-Code-Race-
     Detection) + `devcontainer up` in einem Aufruf
   - Wird am Ende _jedes_ `add-*`-Befehls als Hinweis ausgegeben
   - Regeneriert `post-create.sh` aus stack.json bei jedem Lauf
     (verhindert stale-after-CLI-upgrade-Probleme)

### ✅ Auth-Infrastruktur (organisch dazugekommen, Phase 1-Erweiterung)

Während der Phase-1-Arbeit kam raus, dass `add-repo` plus
`monoceros apply` nicht reicht — der Container braucht Auth-Setup, um
private Repos zu klonen, zu committen und zu pushen. Drei
Mechanismen wurden ergänzt, alle host-OS- und git-host-agnostisch:

- ✅ **SSH-Agent-Forwarding** — `${localEnv:SSH_AUTH_SOCK}` wird
  in `devcontainer.json` / `compose.yaml` gemountet, sobald
  `stack.json.repos` einen Eintrag hat. Mit
  `GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new"` um
  den first-time-host-key-Prompt zu vermeiden.
- ✅ **HTTPS-Credentials via `git credential fill`** — bei jedem
  `apply` werden host-seitig pro HTTPS-Host Creds gefetcht
  (osxkeychain, manager, libsecret, was auch immer der Host hat) und
  in `.monoceros/git-credentials` geschrieben (mode 0o600). Container-
  git liest sie via `credential.helper=store --file=…`.
- ✅ **Git-Identity** — host-seitig `git config --global --get
user.name`/`user.email`, mit Persistenz in `.monoceros/gitconfig` und
  interaktivem Prompt-Fallback wenn Host kein Global hat. Container-
  git inkludiert die Datei via `include.path`.
- ✅ **`.monoceros/.gitignore`** schließt `git-credentials*` und
  `gitconfig` aus, damit per-Builder-State nicht in Repos rutscht.

### ✅ Phase 2 — `monoceros create` mit `projects/`-Layout (abgeschlossen)

`monoceros create <name>` schreibt das oben skizzierte Layout:

- `projects/`-Folder (leer)
- `<name>.code-workspace` mit nur `"."` als initialem Root
- README erweitert um Workflow-Hinweis („klone Repos nach `projects/`
  via `monoceros add-repo`")

Keine prescriptive Sub-Projekt-Struktur, kein `add-project`-Befehl.
Projekte sind Repos, die der Builder reinklont — Monoceros verwaltet
sie nicht, listet sie nur im `.code-workspace`.

### Phase 3 — YAML-Profile (`<name>.yml`) als wiederverwendbare Konfig

**Neues Modell (Stand 2026-05-15):** Die yml ist **kein per-Dev-
Container-Manifest** sondern ein **wiederverwendbares Profil**, das
außerhalb des Dev-Containers liegt. Mehrere Dev-Container können
dieselbe yml referenzieren; eine Änderung an der yml propagiert beim
nächsten `apply` in jeden Container der sie nutzt.

**Begriffe:**

- **Template** — von Monoceros mitgelieferte Vorlage, read-only.
  Liegt in `templates/yml/<name>.yml` im Workbench-Repo. Beispiele:
  `nodejs-github.yml`, `spring-boot.yml`, `forge-addon.yml`, `php.yml`.
- **Konfig** (oder „User-yml") — eine vom Builder kopierte und
  customizable yml. Liegt während der Dev/Test-Phase in
  `.local/container-configs/<name>.yml` (später, mit Distributions-
  kanal, ggf. an anderem Ort). Diese Datei ist die _Wahrheit_ für
  einen oder mehrere Dev-Container.
- **Stack** — die materialisierte Form einer Konfig in einem
  konkreten Dev-Container-Verzeichnis: `.devcontainer/`, `.monoceros/`,
  Scaffold-Files. Der Stack hat ein `origin: <name>`-Feld, das auf
  die Konfig zurück zeigt.

**Workflow:**

```sh
# 1. Template kopieren (zum Customizen)
monoceros init nodejs-github sandbox
# → kopiert templates/yml/nodejs-github.yml
#   nach .local/container-configs/sandbox.yml

# 2. Konfig anpassen
vim .local/container-configs/sandbox.yml

# 3. Auf ein Dev-Container-Verzeichnis anwenden
mkdir .local/play/sandbox && cd .local/play/sandbox
monoceros apply sandbox
# (entspricht `monoceros apply sandbox .`)
# → liest .local/container-configs/sandbox.yml
# → generiert .devcontainer/, .monoceros/, etc.
# → .monoceros/state.json bekommt `origin: 'sandbox'`
# → Container hochfahren

# 4. Zweiter Dev-Container mit derselben Konfig
monoceros apply sandbox .local/play/sandbox-clone
# → derselbe Stack-Inhalt, andere Container-Instanz

# 5. Re-apply nach Edit der Konfig
vim .local/container-configs/sandbox.yml
cd .local/play/sandbox
monoceros apply
# → liest origin aus .monoceros/state.json, holt yml, re-appliziert

# 6. add-* / remove-* editieren die SHARED Konfig
cd .local/play/sandbox
monoceros add-repo https://...
# → editiert .local/container-configs/sandbox.yml
# → sandbox-clone bekommt das Repo beim nächsten apply
```

**Befehls-Übersicht:**

| Befehl                             | Wirkung                                                          |
| ---------------------------------- | ---------------------------------------------------------------- |
| `monoceros init <template> <name>` | Kopiert Template → `.local/container-configs/<name>.yml`         |
| `monoceros apply <name> [<pfad>]`  | Liest yml, generiert Stack im Pfad (default cwd)                 |
| `monoceros apply` (ohne Arg)       | Liest `origin` aus `.monoceros/state.json` in cwd, re-appliziert |
| `monoceros add-* …`                | Editiert die yml, auf die der Stack via `origin` zeigt           |
| `monoceros remove-* …`             | Symmetrisch zu `add-*`, entfernt Einträge aus der yml            |

**yml-Schema (Skelett):**

```yaml
schemaVersion: 1
name: sandbox

languages: [python, node]
aptPackages: [make, openssh-client, jq]
features:
  - ref: ghcr.io/devcontainers/features/docker-in-docker:2
    options: { version: latest }
installUrls:
  - https://teamwork-graph.atlassian.com/cli/install
services: [postgres]
repos:
  - url: git@github.com:foo/bar.git
  - url: https://github.com/baz/qux.git
    name: ui
    branch: develop
git:
  user:
    name: Thorsten Kamann
    email: thorsten.kamann@conciso.de
```

**Mechanik-Entscheidungen (Stand der Diskussion):**

- yml-Parser: `yaml`-package (eemeli), kann Comments beim Round-Trip
  erhalten — wichtig wenn Builder Notes in der yml stehen lassen will.
- Validierung: Zod-Schema vor jedem Apply; klare Fehler bei
  Schema-Verletzung, kein „halb angewendet"-Zustand.
- `monoceros apply <template>` ohne lokale yml in cwd: Error mit
  Hinweis auf `monoceros init <template> <name>` first.
- Pfad-Auflösung: `apply <name>` resolves `.local/container-configs/<name>.yml`.
  Builder kann auch absoluten Pfad geben (`apply ./my-yml.yml`) — name-
  Resolver fällt dann auf Pfad-Behandlung zurück wenn `name` ein
  Pfad-Pattern matched.
- Stack-Persistenz: `.monoceros/state.json` ersetzt das alte
  `stack.json` und enthält nur noch `{ origin: <name>, …materialisierte
Werte für Diagnose… }`. Die yml bleibt die Wahrheit.

### Phase 3 — Tasks (vor Implementierung verfeinern)

1. **Schema + I/O** — Zod-Schema für yml, `yaml`-package als
   Dependency, Reader/Writer mit Comment-Preservation, Round-Trip-
   Tests in eigenem Modul.
2. **`monoceros init <template> <name>`** — neuer Befehl. Validiert
   Template-Existenz in `templates/yml/`, kopiert nach
   `.local/container-configs/`, Idempotenz wenn die Ziel-Datei schon
   da ist (Error: „existiert schon, manuell löschen wenn re-templated").
3. **`monoceros apply <name> [<pfad>]`** — refactored vom heutigen
   `apply`. Liest yml aus `.local/container-configs/<name>.yml`,
   generiert komplettes Scaffold im Pfad (default cwd), schreibt
   `.monoceros/state.json` mit `origin: <name>`, dann container-up.
4. **`monoceros apply` (ohne Args)** — liest `state.json` in cwd,
   ermittelt origin, ruft yml ab, re-appliziert.
5. **`add-*` lesen+schreiben die yml** — refactored. Statt heute
   `stack.json` zu mutieren: yml laden, Eintrag hinzufügen, yml
   schreiben. State.json wird beim nächsten Apply aktualisiert.
6. **`remove-*`-Befehlsfamilie** — symmetrisch zu `add-*`. Editiert
   die yml. Builder muss apply für die Materialisierung aufrufen.
7. **`stack.json` → `state.json`-Migration** — bestehende Solutions
   (mit stack.json) werden beim ersten apply transparent auf das neue
   Modell migriert: yml wird aus stack.json generiert, in
   `.local/container-configs/<name>.yml` abgelegt, state.json
   geschrieben, stack.json archiviert.
8. **Templates ausarbeiten** — wenigstens drei Anfangs-Templates:
   `nodejs-github.yml`, `python.yml`, `bare.yml`. Spring-Boot, Forge,
   PHP etc. dann als Folge-PRs.
9. **Doku** — `docs/commands/init.md`, `docs/commands/apply.md` neu
   schreiben, README in `templates/yml/` als Template-Katalog.

### ✅ Phase 1+2 Tasks (alle erledigt)

1. ✅ **Workspace-Layout-Refactor** — `monoceros create` schreibt
   `projects/`-Folder + `<name>.code-workspace`. 4 Tests dafür in
   `create.test.ts`. `findSolutionRoot()`-Aufwärtswalk aus
   `projects/<name>/` separat getestet.
2. ✅ **`monoceros apply`** — Container-Teardown mit Label-basiertem
   Force-Remove und VS-Code-Race-Detection, dann `devcontainer up`.
   Regeneriert post-create.sh aus stack.json bei jedem Lauf.
3. ✅ **`monoceros add-apt-packages`** — funktioniert.
4. ✅ **`monoceros add-feature`** — funktioniert, mit Options-Hash
   und Smart-Coercion (true/false → bool, integers → number).
5. ✅ **`monoceros add-from-url`** — funktioniert, mit lautem
   Security-Warn. `curl -fsSL "<url>" | sh` (nicht bash, weil das
   für die meisten Install-Scripts wie starship Voraussetzung ist).
6. ✅ **`monoceros add-repo`** — funktioniert, mit SSH-Agent-
   Forwarding, HTTPS-Credentials-Fetch und Git-Identity-Capture.
   Auth funktioniert für GitHub, GitLab, Bitbucket, Gitea, …
   automatisch.

(Phase-3-Tasks oben aufgelistet.)

### Definition of Done

- ✅ Phase 1+2: alle vier neuen `add-*`-Befehle plus `apply` arbeiten
  end-to-end, idempotent. Auth läuft automatisch (SSH + HTTPS +
  Identity). `projects/`-Layout angelegt. Stage-E-Walkthrough mit
  dem neuen Layout durchgespielt und manuell bestätigt
  (clone + commit + push gegen Conciso-private-Repo grün).
- Phase 3: `monoceros init <template> <name>` und
  `monoceros apply <name> [<pfad>]` funktionieren. yml lebt in
  `.local/container-configs/`, ist die Wahrheit. `state.json`
  ersetzt `stack.json`. Migration bestehender Solutions transparent.
  Drei Initial-Templates ausgearbeitet (`nodejs-github`, `python`,
  `bare`).

### Bewusst nicht in M2.5

- Komplexes Provider-Specific-Auth-Setup für HTTPS-Git jenseits von
  `git credential fill` (z. B. PAT-Management, OAuth-Token-Refresh)
  — der Builder bringt seine Host-Auth mit, Monoceros liest sie aus.
- Curated Whitelist für `add-feature` — der Builder kann beliebige
  Feature-Refs übergeben. Kein „nur diese sind erlaubt"-Schutz.
- Code-internes Rename `solution` → `dev container` —
  Sprachinkonsistenz im CLI-Code (`findSolutionRoot`, „solution
  directory"-Fehlermeldungen, `runCreate`-Kommentare etc.). Separate
  Mini-Refactor-Aufgabe, blockiert nichts.

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

## M4 — Go-Live (Public-Release)

**Ziel:** Workbench ist für einen zweiten Solution Builder ohne
Insider-Knowledge nutzbar. Voraussetzung: M1–M3 stabil, ein
realistischer Nutzer-Flow lässt sich von außen durchspielen.

Wird konkret geplant nach Abschluss von M3. Heute schon klare
Bausteine:

### Tasks (Stand: Skizze, wird vor M4-Start verfeinert)

1. **Multi-Arch-Image auf GHCR publishen** — vormals M1-Task-8c.
   `docker buildx` für `amd64 + arm64`,
   `ghcr.io/kamann/monoceros-runtime:<tag>`, GitHub-Actions-Workflow
   für reproducible Builds bei Tag-Push. `BASE_IMAGE` in
   [`catalog.ts`](../packages/cli/src/create/catalog.ts) zeigt auf
   den GHCR-Tag statt aufs lokal-gebaute `dev`. Damit braucht ein
   neuer Builder kein `pnpm image:build` mehr — Docker zieht das
   Image beim ersten Container-Start.
2. **Auth-Smoke auf zweitem Rechner** — vormals M1-Task-10.
   Realistischer „neuer Solution Builder"-Flow: fremder Rechner,
   Workbench-Repo klonen, neue Solution anlegen, in den Container
   gehen, prüfen dass Claude ohne extra Setup auth'd ist (mit dem
   bekannten macOS-Keychain-Erstaufruf). Findet Pfad-/Permission-/
   OS-spezifische Annahmen, die im Solo-Setup unsichtbar bleiben.
3. **Git-Bootstrap in generierten Solutions** — `.gitignore`,
   optional `git init`, klare Policy für `.monoceros/`-Subdirs.
   Heute in „Vorgemerkt für später", gehört hierher weil's
   relevant ist sobald Solutions geteilt werden.
4. **Installations-Pfad für Endnutzer** — `@monoceros/cli` als
   echtes npm-Paket vorbereiten (`private: false`, README-Quickstart,
   evtl. eigene `bin/`-Verdrahtung). Ablösung des
   Session-Alias-Workarounds aus dem Test-Plan-Setup.
5. **Onboarding-Doku** — Quickstart-Guide, Konzept-Zusammenfassung
   für Außenstehende, Beispiel-Solution. Aktueller `docs/konzept.md`
   ist eine Entwurfs-/Hintergrund-Notiz, kein Onboarding.
6. **Threat-Model-Review** — was der HTTPS-Forward-Proxy-Sidecar
   und das Audit-Log-Egress (beide in „Vorgemerkt") für Public-
   Release-Anforderungen bedeuten — werden eines davon zur
   Bedingung, kommt's hierher.
7. **Plugin-Source auf GitHub-Marketplace umstellen** — Heute (Dev)
   schreibt `monoceros create` eine `.claude/settings.json` mit
   `extraKnownMarketplaces.monoceros-workbench.source = { source:
"directory", path: "/opt/monoceros-workbench" }`. Setzt voraus,
   dass jeder Builder einen Workbench-Checkout per Bind-Mount im
   Container hat — Live-Reload für Dev. Für Public-Release wird die
   `directory`-Source durch `github` ersetzt (`{ source: "github",
repo: "kamann/monoceros" }` o. Ä., je nach Publish-Repo), und der
   Bind-Mount in `devcontainer.json` / `compose.yaml` kann entfallen.
   Konkrete Datei-Änderungen: `buildClaudeSettings()` in
   [`packages/cli/src/create/scaffold.ts`](../packages/cli/src/create/scaffold.ts)
   (eine Funktion), `buildDevcontainerJson` / `buildComposeYaml` für
   den entfallenden Mount, ein Test in
   [`create.test.ts`](../packages/cli/test/create.test.ts), plus
   Update der `.claude-plugin/marketplace.json` (oder Löschen, falls
   Plugin auf einen Default-Marketplace gelistet wird). Trigger: M4-
   Distribution-Pfad ist final entschieden (GHCR-Image + npm-CLI +
   ggf. GitHub-Marketplace für das Plugin).

Weitere „Vorgemerkt"-Items werden bei M4-Planung neu bewertet —
einige (Persistenz-Strategie, E2E-Test-Suite, Service-Init-
Konfiguration) könnten je nach Reife mit reingezogen werden.

### Definition of Done

- Ein zweiter Solution Builder kann Repo klonen, Solution anlegen,
  Claude im Container nutzen — ohne Workbench-Repo-internen
  Build-Schritt
- Quickstart-Guide deckt diesen Pfad ab
- Image im GHCR, beide Architekturen
- Mindestens ein erfolgreich durchgespielter Auth-Pass-Through-Test
  auf einem nicht-Entwickler-Rechner

---

## Vorgemerkt für später (jenseits M3)

Items die jetzt nicht eingeplant sind, aber bewusst getrackt:

- **Orchestrator-Side Live-App-Probe** — ursprünglich M2 Task 6.
  Idee: nach Phase 2 ein deterministischer HTTP-Check vom Pipeline-
  Code selbst, damit „Lügen im Generator-Report bringen nichts". Das
  Archiv hatte Vite/Fastify-Ports (3000/4000) hardgecodet — stack-
  agnostisch ist es nur sinnvoll baubar, wenn wir wissen, wie die
  Solution ihre Endpunkte deklariert. Drei Optionen wurden bewertet
  (Builder-Vorab-Deklaration in `stack.json`, Generator-deklarierte
  Probes im Report, TCP-Liveness-Check auf `forwardPorts`) — alle
  haben Schwächen ohne empirische Begründung. Reaktivierungs-Trigger:
  M2-Task 7 zeigt, dass Claude die App-Liveness in Generator- oder
  Reviewer-Report fälscht. Dann ist klar, welche Form die Probe haben
  muss. Bis dahin verlassen wir uns auf den Reviewer-Agent, der seine
  curl-Probes via Bash-Tool selbst macht (siehe Reviewer-Prompt).
- **`monoceros iterate`-CLI-Bridge** — alternative Eingangs-Schicht
  zum Plugin. Aus M2 rausgeschnitten weil der Plugin-Pfad alleine
  trägt (siehe [ADR 0004](adr/0004-orchestrator-und-plugin-im-devcontainer.md)).
  Wenn ein Builder das Plugin _nicht_ nutzen will (z. B. headless
  CI-Run, Skript-Pipeline), wird die CLI-Bridge zum dünnen Wrapper:
  `monoceros run -- node /path/to/orchestrator-entry.js "<prompt>"`.
  Trigger zum Reaktivieren: erster realistischer Anwendungsfall
  ohne interaktiven Claude-Code-Client.
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
- **Service-Init-Konfiguration** — die `SERVICE_CATALOG`-Einträge in
  [`catalog.ts`](../packages/cli/src/create/catalog.ts) liefern heute
  feste Init-Werte: postgres mit Locale `en_US.utf8` und FTS-Default
  `english`, mysql mit Default-Charset, redis ohne Memory-Limits. Für
  95% der Anwendungen reicht App-Layer-Handling
  (`ORDER BY x COLLATE "de_DE"`, `to_tsvector('german', …)`,
  `maxmemory` zur Laufzeit). Wenn ein konkreter Bedarf kommt
  (FTS-Indizes ohne expliziten Config-Namen, locale-pinned Tests,
  …), ist der Weg klar: postgres unterstützt
  `POSTGRES_INITDB_ARGS=--locale=de_DE.utf8` + `LANG=de_DE.utf8` als
  Env, mysql nimmt `MYSQL_INITDB_ARGS`, redis hat eine `command:`-
  override-Convention. Statt curated CLI-Flags pro Service-Eigenheit
  wahrscheinlich generisch ein `--service-env <svc>=<key>=<value>`-
  Passthrough plus optionale `serviceOverrides`-Sektion in
  `.monoceros/stack.json`. Erste echte Anwendung steuert das Design
  realistischer als Spekulation.
- **Git-Bootstrap in generierten Solutions** — `monoceros create`
  legt heute `.devcontainer/`, `.monoceros/stack.json`, `README.md`
  an, aber keine `.gitignore` und kein initialisiertes Git-Repo.
  Konvention laut Devcontainer-Spec ist, dass `.devcontainer/` und
  `.monoceros/stack.json` versioniert mitgehen — damit „Reopen in
  Container" beim Klonen funktioniert. Folge-Items:
  - `.gitignore`-Template mit `node_modules/`, `dist/`, `.env*`,
    `.monoceros/backups/` (sobald Backups kommen).
  - optional `git init` als Teil von `monoceros create`, evtl.
    `--no-git`-Opt-out für Sub-Repos.
  - falls Findings-Backlog (M2) versioniert mitgeht: explizit
    dokumentieren welche `.monoceros/`-Subordner committen vs. ignore.

  Sinnvoll im Rahmen von M2 oder direkt danach, wenn die GitHub-/Jira-
  Anbindung steht — dann ist der Workflow rund um „Solution-Repo
  anlegen, pushen, im Team teilen" gefestigt und das Bootstrap kann
  die Konventionen mit reinpacken.

- **Persistenz-Strategie für Service-Daten** — heute liegen
  Postgres/MySQL/Redis-Daten in Docker-Named-Volumes
  (`<solution>_devcontainer_<svc>-data`). Sicher gegen
  `monoceros stop`/`down`, aber **nicht im Workspace** — Daten
  überleben `down --volumes`, `docker volume prune` oder Docker-
  Desktop-Reset nicht. Drei Wege wenn das relevant wird:
  - **Backup/Restore-CLI**: `monoceros db:dump` /
    `monoceros db:restore` (`pg_dump`/`pg_restore`), Backups landen
    versioniert im Workspace (`.monoceros/backups/`). Default-Lösung,
    weil performance-neutral.
  - **Bind-Mount-Variante** opt-in per `monoceros create --postgres-storage=bind`:
    Daten liegen in `<solution>/.monoceros/data/postgres/`. Portabel,
    aber auf macOS-Docker-Desktop deutlich langsamer (Bind-Mount mit
    vielen kleinen Files) und UID-Mismatch zwischen Host und
    postgres-User kann zicken.
  - **Multi-Service generalisieren**: gleiche Optionen für mysql/redis,
    nicht nur postgres.
    Heute keine Priorität — Test-Data ist meist weggeworfen, ernsthafte
    Daten gehören in Migrations + Seeds, nicht in raw pgdata.
- **Audit-Log Egress** — niederschwelliger Vorläufer zum Enforcement:
  alle Egress-Verbindungen aus dem Container mitschreiben (Hostname,
  Port, Process-ID, evtl. Argv) ohne sie zu blockieren. Macht
  sichtbar, was Claude und seine Tools _tatsächlich_ rauspusten, ohne
  den Workflow zu brechen. Mögliche Mechaniken: iptables-LOG-Target
  auf alle OUTPUT-Pakete, Captured-DNS via eigenem Resolver, oder
  eBPF-Probes. Liefert Material für die spätere Allowlist-Definition.
- **HTTPS-Forward-Proxy-Sidecar** — die strukturell richtige Lösung
  für Egress-Enforcement, die der ursprüngliche iptables-Ansatz nicht
  liefern konnte. Eigener Compose-Service, der pro Request neu
  Hostnames auflöst und Allowlist-Entscheidungen pro CONNECT trifft.
  Damit kein CDN-IP-Drift-Problem mehr. Komplexer Umbau — passende
  Aufgabe wenn der Schutzbedarf konkret zurückkommt (Multi-User,
  Public-Release, unbeobachtete Agent-Sessions). Trifft auch den
  vorigen „HTTPS-Content-Filter"-Punkt mit ab.
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
