# Monoceros Workbench

Frischer Start am **2026-05-10**. Die Vorgänger-Codebasis liegt unter
[`../monoceros-for-solution-builder_archive-2026-05-10/`](../monoceros-for-solution-builder_archive-2026-05-10/),
das ältere Archiv unter
[`../monoceros_archive_2026-04-30/`](../monoceros_archive_2026-04-30/).

Das Produkt heißt weiterhin **Monoceros**. Das Verzeichnis heißt
`monoceros-workbench`, weil es der gemeinsame Stamm für CLI, Plugin und
Tracking-Adapter ist — also mehr als nur ein Tool, eine Werkbank.

## Was Monoceros ist (Stand 2026-05-10)

Eine **lokale, abgesicherte Entwicklungsumgebung mit AI-Coding-Tooling**
für Solution Builder. Drei Bausteine:

1. **Sichere Devcontainer-Sandbox** — Linux-Container mit Claude Code
   (später opencode), komponierbaren Services (Postgres, MySQL, …) und
   Sprach-Toolchains via Devcontainer-Features. Sprach- und
   Stack-agnostisch — Node, Python, Java, Rust, Go, .NET laufen alle.
2. **Strukturierte Iteration-Pipeline** — der Plan/Generate/Review-Workflow
   aus dem Vorgängerprojekt als Claude-Code-Plugin. Der Reviewer findet
   Risiken und Concerns, die Claude Code allein nicht von sich aus sieht.
3. **Side-Topic-Memory** — Findings, Concerns, Risks, deferred Items werden
   automatisch aus der Pipeline akkumuliert und im Repo unter `.monoceros/`
   versioniert. Als Markdown lokal, später optional gespiegelt in GitHub
   Issues / Jira / Notion / Linear.

Was Monoceros **nicht** ist: keine Cloud-Plattform, kein SaaS, kein
fester Tech-Stack, keine eigene Web-UI im MVP. Alles läuft lokal beim
Builder.

## CLI-Modell (Stand 2026-05-17, M2.5 Phase 3 done)

Alle Befehle folgen der Form:

```sh
monoceros <command> <containername> [<args> …]
```

Layout unter `$MONOCEROS_HOME` (dev: `<workbench>/.local`, prod:
`~/.monoceros`):

```
container-configs/<name>.yml   ← yml-Profil (Quelle der Wahrheit)
container/<name>/              ← materialisierter Dev-Container
monoceros-config.yml           ← optionale globale Defaults
monoceros-config.sample.yml    ← Marker + Vorlage (committed in dev)
```

Workflow:

```sh
monoceros init <template> <name>          # yml aus Vorlage
monoceros apply <name>                    # → container/<name>/
monoceros shell <name>                    # darin arbeiten
monoceros add-feature <name> <ref>        # yml editieren
monoceros apply <name>                    # neu bauen
```

cwd ist irrelevant — alles geht über Konvention.

## Lese-Reihenfolge für neue Sessions

1. Diese Datei (kurz, gibt den Reset-Kontext)
2. [`docs/design-pivot-autonomous-iterate.md`](docs/design-pivot-autonomous-iterate.md)
   — **offene Design-Diskussion vom 2026-05-13**, die das M2-Modell
   möglicherweise auf einen autonomen Loop mit PR-Output umstellt.
   Solange diese Notiz existiert, ist konzept.md _teilweise überholt_:
   die drei Phasen Plan/Generate/Review bleiben, aber Side-Topic-Memory
   (Findings/Concerns/Risks) und M3 (Tracking-Adapter) sind in Frage
   gestellt. Lies das _vor_ konzept.md, damit du den Diskussionsstand
   mitbekommst
3. [`docs/konzept.md`](docs/konzept.md) — die ursprüngliche Story: warum
   so, wie es funktioniert, was bewusst draußen bleibt. Wird überarbeitet,
   sobald die offenen Fragen aus dem Design-Pivot beantwortet sind
4. [`docs/backlog.md`](docs/backlog.md) — die drei Milestones mit
   detaillierten Tasks. Das ist die Roadmap und gleichzeitig
   Arbeits-Backlog
5. Bei Detail-Fragen ins Vorgänger-Archiv schauen — viele Entscheidungen
   (Drizzle, Fastify, Iteration-Prompts, Container-Sandbox-Modell) sind
   dort durchdacht und teilweise direkt übernehmbar

## Was aus dem Archiv übernommen wird (geplant)

Direkt 1:1:

- Iteration-Prompts unter
  [`../monoceros-for-solution-builder_archive-2026-05-10/apps/api/src/lib/iteration-prompts/`](../monoceros-for-solution-builder_archive-2026-05-10/apps/api/src/lib/iteration-prompts/)
  — werden Stack-agnostisch umgeschrieben (lesen Code statt vorzuschreiben)
- Zod-Schemas für `IterationPlan`, `GeneratorReport`, `ReviewReport`
- Orchestrator-Mechanik aus
  [`iteration-orchestrator.ts`](../monoceros-for-solution-builder_archive-2026-05-10/apps/api/src/lib/iteration-orchestrator.ts)
  — DB-Persistenz raus, File-Append nach `.monoceros/iterations/` rein
- Runtime-Dockerfile aus
  [`apps/runner/`](../monoceros-for-solution-builder_archive-2026-05-10/apps/runner/)
  — Auth/Enrollment-Kram raus, sonst Basis fürs Devcontainer-Image
- husky + lint-staged + prettier-Setup (aus dem älteren Archiv)

Was **nicht** mitgeht:

- Studio-Frontend (`apps/studio`)
- Fastify-API als zentraler Service (`apps/api`)
- Runner als Server mit Reverse-Proxy + Auth (`apps/runner`)
- BASE_PATH-Routing-Modell, Per-Runner-Secrets, AES-Encryption
- Plan→Flow-Modell als zentrale Daten-Struktur (Findings ersetzt das)

## Konventionen

- **Commit-Messages** auf Englisch
- **Source-Code-Dokumentation** (Kommentare, JSDoc) auf Englisch
- **User-Doku** (README, Konzept-Dokumente, Backlog, Befehlsdocs unter
  `docs/commands/`) auf Deutsch — der primäre Solution Builder ist
  deutschsprachig
- **Pro neuer CLI-Befehl** eine MD-Datei unter `docs/commands/<name>.md`
  im selben Commit wie der Code, und ein Verweis in
  [`docs/commands/README.md`](docs/commands/README.md). Generierte
  Solutions zeigen via README auf `/opt/monoceros-workbench/docs/commands/`
- **Context7** ist die erste Anlaufstelle für externe Library-Versionen.
  Tools: `mcp__context7__resolve-library-id` und
  `mcp__context7__query-docs`. Niemals Versionsnummern aus dem Gedächtnis
  schreiben — Archiv-Versionen sind per Definition veraltet
- **Server-Prozesse niemals manuell starten/killen.** Sobald Dev-Server
  in Spiel kommen, wird das via `.claude/launch.json` konfiguriert
- **Keine globale git-Config ändern.** Pro Repo lokal, nichts darüber
  hinaus
- **ADRs** werden ab dem ersten echten Code unter `docs/adr/` abgelegt
  (Markdown, nummeriert, kurz). Konzept-Dokumente in `docs/`, ADRs sind
  spezifischer

## Stack der Workbench selbst (nicht der Solutions, die damit gebaut werden)

- pnpm Workspaces (sobald M0 läuft)
- TypeScript + Node.js 20+
- Vitest für Tests
- prettier + eslint via lint-staged + husky

Die Workbench ist sprach-agnostisch _für die Solutions, die mit ihr
gebaut werden_. Aber die Workbench-Codebasis selbst ist TypeScript —
wie das Vorgängerprojekt.
