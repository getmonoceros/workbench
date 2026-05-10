# Monoceros Workbench

Lokale, abgesicherte Entwicklungsumgebung mit AI-Coding-Tooling für
Solution Builder. Sprach- und Stack-agnostisch. Kein Cloud, kein SaaS.

> Stand: Bootstrap am 2026-05-10. Code folgt mit
> [M1](docs/backlog.md#m1--devcontainer-cli).

## Was das ist

Drei Bausteine:

1. **Devcontainer-CLI** — `monoceros create my-app` baut eine
   abgesicherte lokale Dev-Umgebung mit Claude Code, optional Postgres /
   MySQL / Redis und Sprach-Toolchains für Node / Python / Java / Rust /
   Go / .NET.
2. **Claude-Code-Plugin** — strukturierte Plan/Generate/Review-Pipeline
   mit lokalem Findings-Backlog als versionierte Markdown-Files.
3. **Tracking-Adapter** — optionale Spiegelung der Findings in GitHub
   Issues / Jira / Notion / Linear.

## Lese-Reihenfolge

- [`CLAUDE.md`](CLAUDE.md) — Reset-Kontext für KI-Sessions
- [`docs/konzept.md`](docs/konzept.md) — die volle Story
- [`docs/backlog.md`](docs/backlog.md) — Milestones M0–M3 mit Tasks
