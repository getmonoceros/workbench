# Monoceros — Konzept

Dieses Dokument beschreibt das Produkt, die Re-Positionierung gegenüber
den Vorgänger-Iterationen und die Architektur der Workbench. Es ist die
gemeinsame Quelle, auf die `CLAUDE.md` und `docs/backlog.md` verweisen.

## Geschichte (warum es vier Iterationen gab)

Monoceros hat einen Weg hinter sich:

1. **AI-first Alternative zu Jira/Confluence/Notion/Linear** — gestartet
   als breiter Workspace-Anspruch.
2. **„Brauchen wir noch ein Kanban-Tool?"** — Frage nach dem
   Differenzierungs-Kern.
3. **Erster Versuch mit vielen Artefakten** — Flows, Personas, Decisions,
   Domain Model, alles als Top-Level-Citizens. Die App fühlte sich an wie
   Confluence mit Status-Pills.
4. **Solution Builder mit Container-Run + Plan/Generate/Review** — der
   Stand vor diesem Reset. Validierte das Sandbox-Asset und die
   3-Phasen-Pipeline, kämpfte aber mit IA-Komplexität (Studio-UI,
   Routing-Modell, Auth-Enrollment) und hartkodiertem Tech-Stack.

Der Lakmus-Test im Mai 2026: derselbe Brief (Studio-Hummel-Demo) wurde
einmal durch Monoceros gejagt und einmal direkt mit Claude Code aus
einem leeren Verzeichnis gebaut. Die Claude-Code-Variante war um
Dimensionen besser. Diagnose: das Stack-Template hat die Architektur
festgelegt, _bevor_ der Brief verstanden war (Postgres-Backend für eine
App, die nach Brief eindeutig localStorage-only sein sollte). Das
Iteration-Budget des Generators wurde von Plumbing gefressen, nicht für
UI-Qualität investiert.

## Die Re-Positionierung (Mai 2026)

Aus den vier Iterationen haben sich zwei genuin wertvolle Assets
herauskristallisiert:

- **Die abgesicherte Devcontainer-Sandbox** — beliebige Node/Python/Java/…
  -Apps inklusive Postgres entwickeln, ohne den lokalen Rechner zu
  gefährden.
- **Die strukturierte 3-Phasen-Pipeline (Plan/Generate/Review)** —
  Reviewer findet Risiken und macht Reviews in einer Form, die Claude
  Code von sich aus nicht macht.

Alles andere (Studio-UI, Plan→Flow als Daten-Modell, Stack-Templates,
Multi-User-Architektur, Cloud-Anbindung) hat sich nicht bewährt. Die
neue Positionierung dreht das um:

> **Monoceros ist eine lokale, abgesicherte Entwicklungsumgebung mit
> AI-Coding-Tooling und strukturierter Iteration-Disziplin. Sprach- und
> Stack-agnostisch. Kein Cloud, kein SaaS.**

Das ist ein _größerer_ adressierbarer Markt als der vorherige
Anspruch — nicht nur Node-Builder, sondern jede:r, die/der mit AI
sicher in beliebiger Sprache bauen will. Gleichzeitig _weniger_ direkte
Konkurrenz mit Cursor/Claude Code (die _Werkzeuge_ sind, nicht
_Umgebungen_).

## Die drei Bausteine

### 1. Devcontainer-Sandbox

Lokaler Docker-Container nach
[Devcontainer-Spec](https://containers.dev/) — der Industriestandard,
den VS Code, Cursor, JetBrains und Claude Code alle nativ unterstützen.

Inhalt:

- Linux-Basis mit Docker-in-Docker
- Claude-Code-CLI vorinstalliert (später opencode parallel)
- pnpm für Node-Solutions, sonst je nach gewähltem Sprach-Feature
- Komponierbare Services über `compose.yaml`: Postgres, MySQL, SQLite,
  Redis nach Bedarf
- Komponierbare Sprach-Toolchains über
  [Devcontainer-Features](https://containers.dev/features) — `python`,
  `java`, `dotnet`, `rust`, `go`, alle aus der offiziellen
  Community-Sammlung, nichts selbst pflegen
- Egress-Whitelist und non-root-User mit sudo (aus dem Archiv übernommen)

Auth-Pass-Through: das Container-Setup mountet `~/.claude/` vom Host als
Bind-Mount, damit der Builder mit seinem normalen Claude-Account
(Subscription oder API-Key) im Container eingeloggt ist. Kein doppelter
Login, kein API-Key-in-Env-Setup.

Persistenz pro Projekt: jeder Devcontainer hat seine eigene
`compose.yaml` mit eigenen Service-Containern und Volumes. Reset eines
Projekts = `docker compose down -v` und alle Daten sind weg.
External-DB-URL ist der Escape-Hatch (`monoceros create … --postgres-url=…`).

### 2. Strukturierte Iteration-Pipeline

Die Plan/Generate/Review-Mechanik aus dem Archiv, neu verpackt als
Claude-Code-Plugin (Slash-Commands + Hooks) statt zentraler Service.

Drei Phasen pro Iteration:

- **Planner** — liest den User-Prompt, inspiziert den Workspace,
  produziert einen Plan mit Acceptance Criteria, Risks, Out-of-Scope
- **Generator** — setzt den Plan in Code-Änderungen um, läuft Tests,
  führt Live-App-Probe durch
- **Reviewer** — bewertet das Ergebnis, produziert Findings mit
  Severity, gibt eine Recommendation (approve / request_changes / reject)

Alle drei Phasen laufen via `claude --print` mit phasen-spezifischem
System-Prompt im selben Container. Output ist Zod-validiert. Bei
Schema-Verletzung läuft ein Retry mit Validation-Feedback.

Wesentliche Änderung gegenüber dem Archiv: die Prompts sind
**Stack-agnostisch**. Statt „nutze Drizzle, Zod, Vite" sagt der Prompt
„lies 3-5 repräsentative Files (z.B. `package.json` / `pyproject.toml` /
`pom.xml` / `go.mod` / `Cargo.toml`), identifiziere Test-Framework, ORM,
Conventions, folge dem was du dort findest". Der
`ARCHITECTURE_PHILOSOPHY_BLOCK` (lean, schema-first, plain functions,
defaultlos) bleibt — das sind sprachinvariante Prinzipien.

Optional pro Projekt: eine `.monoceros/conventions.md`, in die der
Builder Stack-Eigenheiten schreiben kann, die nicht aus 3 Files ablesbar
sind („wir nutzen Result-Types, kein Throw"). Reines Override für
Edge-Cases.

### 3. Side-Topic-Memory

Die Pipeline produziert von sich aus eine Menge Material, das heute im
Archiv-Stand pro Iteration in einer Reportcard angezeigt und dann im
JSONL begraben wird:

- Reviewer-Findings (mit Severity, Empfehlung)
- Generator-Concerns (was bemerkt wurde aber nicht gemacht)
- Generator-Plan-Deviations (warum vom Plan abgewichen wurde)
- Planner-Risks (wo's brennen kann)

Die Re-Positionierung hebt das hervor: **das Side-Topic-Backlog ist kein
zusätzliches Tool, sondern automatischer Output der Pipeline**. Capture
ist Null-Friktion. Der Builder _kuratiert_ nur — markiert Items als
„jetzt", „später", „verworfen", oder triggert eine Folge-Iteration die
genau das Item adressiert.

Speicherort: `.monoceros/findings/*.md`, `.monoceros/concerns/*.md`,
`.monoceros/risks/*.md`, `.monoceros/iterations/*.json` (Audit-Trail).
Alles versioniert mit dem Code, wandert mit Branches mit, Code-Reviews
zeigen Findings-Diffs nebenbei.

Spätere Tracking-Adapter (M3) spiegeln dieselben Items in externe
Systeme: GitHub Issues, Jira, Notion, Linear. Die Markdown-Files bleiben
Source of Truth, der Adapter synchronisiert.

## CLI-Shape

Die Workbench ist primär eine CLI. Vier Befehl-Familien:

```bash
# Projekt-Lifecycle
monoceros create <name> [--languages=node,python] [--services=postgres]
monoceros shell                    # in den Container, aus cwd abgeleitet
monoceros run -- <cmd>             # one-off im Container
monoceros logs [<service>]         # tail
monoceros stop / start / status

# Iteration (in M2 mit Plugin-Integration)
monoceros iterate "<prompt>"       # P/G/R-Pipeline
monoceros findings                 # offene Findings auflisten
monoceros triage                   # Batch-Markierung (später optional TUI)

# Service-Management (post-create)
monoceros add-service redis
monoceros add-language python
```

Working-Directory-Awareness: alle Befehle leiten den Container aus der
cwd ab (suchen aufwärts nach `.devcontainer/`/`.monoceros/`). Kein
Name-Parameter notwendig. `--project=<name>` als Override für
Cross-Project-Skripte.

## Code-Layout der Workbench

Mono-Repo mit pnpm-Workspaces (Vorgänger-Pattern):

```
monoceros-workbench/
├── packages/
│   ├── cli/                # M1: das `monoceros`-CLI
│   ├── core/               # geteilt: Iteration-Prompts, Orchestrator, Types
│   ├── plugin/             # M2: Claude-Code-Plugin
│   ├── adapter-local/      # M2: Findings als Markdown
│   ├── adapter-github/     # M3
│   ├── adapter-jira/       # M3
│   ├── adapter-linear/     # M3
│   └── adapter-notion/     # M3
├── images/
│   └── runtime/            # Dockerfile fürs Base-Image
├── templates/
│   └── default/            # Devcontainer-Default-Template (minimal)
└── docs/
```

Begründung: M1/M2/M3 teilen Kern-Code (Iteration-Prompts,
Finding-Schemas), das ist im Mono-Repo ein Workspace-Import statt
npm-Versionierung. Atomare Cross-Package-Änderungen ohne PR-Choreografie.
Splitten geht später, mergen ist Schmerz.

## Was bewusst nicht ins MVP gehört

- Eigene Web-UI für Findings-Triage (nur CLI / Markdown-Files; TUI nur
  wenn Markdown-Strecke sich als zu zäh erweist)
- Multi-User / Shared-State (jede:r Builder lokal, Repo-basierte Sync
  über git)
- Cloud-Hosting / SaaS-Variante
- Eigene Auth-Infrastruktur (Bind-Mount von `~/.claude/` reicht)
- Fixe Stack-Templates (`vite-react-pg` und Co.) — nur das minimale
  Default-Template, alles andere kommt aus Devcontainer-Features +
  Service-Snippets, die der Builder kombiniert
- Plan→Flow-Datenmodell als zentraler Artefakt-Anker (Findings ersetzt
  das)

## Form-Faktor-Diskussion

Vor dem Reset wurden drei Form-Faktoren erwogen:

1. Claude-Code-Plugin + Devcontainer-Konvention (gewählt)
2. MCP-Server + dünne Web-UI für Backlog
3. Standalone-Suite wie das Vorgänger-Projekt

Form-Faktor 1 ist gewählt, weil er den größten Anteil des
Vorgänger-Codes obsolet macht — alle IA-, Auth-, Routing-, Multi-User-,
Reverse-Proxy-Komplexität verschwindet, weil der Container lokal läuft.
Was bleibt (Iteration-Prompts, Orchestrator-Mechanik, Runtime-Image) ist
direkt aus dem Archiv übernehmbar.

Wenn das MVP mehrere Solutions trägt und eine echte Triage-UI fehlt
fühlt, ist Form-Faktor 2 die natürliche Erweiterung — ein kleines Web-UI
über denselben Core. Der Mono-Repo-Aufbau verhindert nichts davon, das
ist eine spätere Ebene.

## Validierungs-Hypothesen

Der Cut auf Form-Faktor 1 ist eine Wette. Drei Dinge, die nach den
ersten 2-3 selbst gebauten Solutions klar werden:

1. **Reicht Markdown-Files für Findings-Triage?** Wenn nach 3 Iterationen
   `.monoceros/findings/` 15-20 echte Items hat, die der Builder
   _aktiv_ sortieren will → Hypothese bestätigt. Wenn 3 nichtssagende
   Stichworte → die ganze Side-Topic-These war eine Illusion.
2. **Ist die Stack-Agnostik der Prompts gut genug?** Test: eine
   Spring-Boot- oder Python-Solution mit derselben Pipeline bauen.
   Output muss spürbar besser sein als „generic AI-generated code".
3. **Ist Devcontainer-Auth-Pass-Through robust?** Test: ein:e zweite:r
   Builder mit eigenem Claude-Account macht das Setup von Null und
   kommt durch ohne manuelles Auth-Geknete.

Wenn alle drei nach 4 Wochen grün sind, ist die Workbench ein echtes
Produkt. Wenn 1 oder 2 rot ist, ist eine zweite Reset-Runde fällig.

## Bezüge ins Archiv

Wertvoll bei Detail-Fragen:

- [Iteration-Prompts](../../monoceros-for-solution-builder_archive-2026-05-10/apps/api/src/lib/iteration-prompts/)
- [Iteration-Orchestrator](../../monoceros-for-solution-builder_archive-2026-05-10/apps/api/src/lib/iteration-orchestrator.ts)
- [Runner-Image-Setup](../../monoceros-for-solution-builder_archive-2026-05-10/apps/runner/)
- [ADR 0008 — 3-Phasen-Pipeline](../../monoceros-for-solution-builder_archive-2026-05-10/docs/adr/0008-3-phasen-iteration-pipeline.md)
- [ADR 0011 — Prompt-Architektur](../../monoceros-for-solution-builder_archive-2026-05-10/docs/adr/0011-prompt-architektur-daten-vs-system.md)
- [ADR 0005 — Container-Sandbox-Modell](../../monoceros-for-solution-builder_archive-2026-05-10/docs/adr/0005-container-sandbox-und-user-modell.md)
- Husky/Prettier-Setup im
  [älteren Archiv](../../monoceros_archive_2026-04-30/) — wurde
  übernommen
