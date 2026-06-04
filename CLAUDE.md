# Monoceros Workbench

## How do you behave when you code? What principles guide your decisions, your style, your approach to problem-solving?

- Think before coding. State your assumptions out loud. If the request is ambiguous, ask. If a simpler approach exists, push back. Stop when you are confused, name what is unclear, do not just pick one interpretation and run.
- Simplicity first. Write the minimum code that solves the problem. No speculative abstractions. No flexibility nobody asked for. The test: would a senior engineer call this overcomplicated.
- Surgical changes. Touch only what the task requires. Do not improve neighboring code. Do not refactor what is not broken. Every changed line should trace back to the request.
- Goal-driven execution. Turn vague instructions into verifiable targets before writing a line. “Add validation” becomes “write tests for invalid inputs, then make them pass.

---

Das Produkt heißt **Monoceros**. Das Verzeichnis heißt
`monoceros-workbench`, weil wir die Werkbank bauen — den Rahmen, in
dem der Builder seinen Dev-Container baut, ohne dass die Werkbank
selbst vorschreibt was drin liegt.

## Was Monoceros ist

Eine **Werkbank für lokale, reproduzierbare Dev-Container mit AI-Coding-Tooling**.
Builder beschreibt deklarativ, was im Container liegen soll
(Sprache, Services, AI-Tools, Repos), Monoceros materialisiert das.
Sprach- und Stack-agnostisch — Node, Python, Java, Rust, Go, .NET
laufen alle.

Die Differenzierung gegenüber Cloud-Codespaces / Cursor-Cloud:

- **lokal** — kein SaaS, kein Mietzwang, keine Datenabflüsse außer
  bewusst gewählter
- **deklarativ** — die yml ist die Wahrheit, der Container leitet sich
  daraus ab; reproduzierbar zwischen Maschinen
- **AI-Tools sind erstklassig** — Claude Code, OpenCode, Rovo Dev,
  Codex, GitHub Copilot etc. landen als Devcontainer-Features im
  Container
- **Container-Isolation als Default** — alles läuft in einem
  Linux-Container, nicht auf dem Host. Bewusst gemounteter Workspace
  ist exponiert, der Rest des Hosts nicht.

Was Monoceros **nicht** ist:

- keine Cloud-Plattform, kein SaaS, kein fester Tech-Stack
- keine eigene Web-UI
- **kein Iteration-Workflow** — keine Plan/Generate/Review-Pipeline;
  wenn so etwas kommt, dann als separates Projekt das auf der
  Workbench aufsetzt

## CLI-Modell

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
monoceros init <name> [--with-languages=… --with-features=… \
       --with-services=… --with-apt-packages=… --with-repos=… --with-ports=…]
                                          # yml komponieren (ohne --with-*:
                                          # dokumentierte Vorlage)
monoceros list-components                 # Katalog der Komponenten anzeigen
monoceros apply <name>                    # → container/<name>/
monoceros shell <name>                    # darin arbeiten
monoceros add-feature <name> <ref>        # yml editieren
monoceros apply <name>                    # neu bauen
monoceros remove <name>                   # Container restlos abräumen (Backup default an)
monoceros restore <backup-path>           # Container aus Backup wiederherstellen
```

cwd ist irrelevant — alles geht über Konvention.

## Lese-Reihenfolge für neue Sessions

1. Diese Datei (kurzer Überblick)
2. [`docs/concept.md`](docs/concept.md) — die Story der Workbench,
   was Monoceros macht und ausdrücklich nicht macht
3. [`docs/commands/README.md`](docs/commands/README.md) — was die
   CLI heute kann

## Konventionen

- **Commit-Messages** auf Englisch
- **Source-Code-Dokumentation** (Kommentare, JSDoc) auf Englisch
- **User-Doku** (README, Konzept-Dokumente, Befehlsdocs unter
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
- **ADRs** unter `docs/adr/` ablegen (Markdown, nummeriert, kurz).
  Konzept-Dokumente in `docs/`, ADRs sind spezifischer
- **Traefik-Proxy nach Dev-Smoke-Tests aufräumen.** Der
  `monoceros-proxy`-Singleton ist maschinenweit und wird von
  `ensureProxy()` **per Name** wiederverwendet (nicht pro Home, nicht
  pro Port). Wenn du in `.local` (Dev) Port-Tests gemacht hast und der
  Proxy läuft noch, reused ein anschließender Test gegen
  `~/.monoceros` (Prod) genau diesen Container — er watcht dann das
  `.local`-`traefik/dynamic` und Prod-Routen liefern stumm `404`.
  Daher: nach `.local`-Smoke-Tests mit Ports `docker rm -f
monoceros-proxy`, bevor du in einem anderen Home testest (und dem
  Builder keine Proxy-Leiche hinterlässt). Details im README unter
  „Ich entwickle am Workbench".

## Stack der Workbench selbst (nicht der Container, die damit gebaut werden)

- pnpm Workspaces
- TypeScript + Node.js 20+
- Vitest für Tests
- prettier + eslint via lint-staged + husky

Die Workbench ist sprach-agnostisch _für die Container, die mit ihr
gebaut werden_. Aber die Workbench-Codebasis selbst ist TypeScript.
