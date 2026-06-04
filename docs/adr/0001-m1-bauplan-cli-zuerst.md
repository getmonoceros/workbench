# ADR 0001 — M1-Bauplan: CLI und Template zuerst, eigenes Runtime-Image später

- Status: accepted
- Datum: 2026-05-10

## Kontext

Der M1-Backlog (intern) listet die
elf Tasks ursprünglich in einer Reihenfolge, die mit dem Bau und Publish
des eigenen Runtime-Images beginnt (Tasks 1–2) und CLI-Implementierung
sowie Default-Template darauf aufsetzt.

Bei der Planung wurde eine andere Reihenfolge bevorzugt: **CLI und
Template zuerst gegen ein Public-Devcontainer-Base-Image, eigenes Image
erst spät**.

## Entscheidung

Die M1-Tasks werden in dieser Reihenfolge umgesetzt:

1. **CLI-Skeleton** — `packages/cli/` mit citty, alle 9 Subcommands als
   Stubs, Smoke-Tests. _(✅ erledigt 2026-05-10)_
2. **Default-Template** — `templates/default/.devcontainer/devcontainer.json`
   minimal, gegen ein öffentliches Base-Image
   (`mcr.microsoft.com/devcontainers/typescript-node:22-bookworm` o. ä.),
   Bind-Mount von `~/.claude/`, postCreate.
3. **`monoceros create`** — schreibt `.devcontainer/`,
   `.monoceros/stack.json`, `README`-Stub. Flags `--languages` /
   `--services` / `--postgres-url`. Idempotent.
4. **`monoceros shell`** — wrappt `@devcontainers/cli`
   (`devcontainer up` + `devcontainer exec bash`), cwd-Awareness.
5. **`monoceros run -- <cmd>`** — non-interactive, Exit-Code-Propagation.
6. **`monoceros start` / `stop` / `status` / `logs`** — Compose-Passthrough.
7. **`monoceros add-service` / `add-language`** — Mutationen mit
   Diff-Preview.
8. **Eigenes Runtime-Image** — `images/runtime/Dockerfile`, Mechanik aus
   Archiv übernommen, Template-Block raus.
9. **Verifikation auf drei Pfaden** — VS Code Dev Containers, Cursor,
   Claude Code.
10. **Auth-Smoke-Test** — Bind-Mount-Auth out-of-the-box.

Der ursprüngliche Backlog-Task „Image publishen" entfällt als separater
Schritt; das Publish wird Teil von Schritt 8, sobald das Image stabil
ist.

## Begründung

- **Nutzbarer Code früher.** Mit einem Public-Base-Image wird `monoceros
create … && monoceros shell` schon nach Schritt 4 lauffähig — ohne
  Image-Build-Pipeline. Das eigene Image ist eine Verfeinerung, kein
  Blocker.
- **Iterations-Budget für CLI-UX.** CLI- und Template-Entscheidungen
  (Flag-Schema, `.monoceros/stack.json`-Format, `add-*`-Idempotenz)
  haben höhere Auswirkungen auf die spätere Pipeline (M2) als die
  Image-Details. Die kommen besser zuerst.
- **Image-Spec wird durch CLI-Nutzung schärfer.** Wenn CLI und Template
  laufen, ist klar welche Tools im Image _wirklich_ gebraucht werden.
  Andersherum droht Spec-Inflation.
- **Trotzdem M1 vor M2.** Die Reihenfolge bleibt innerhalb von M1 — das
  eigene Image wandert nur ans Ende. M2 startet erst, wenn alle zehn
  Schritte grün sind.

## Konsequenzen

- `templates/default/.devcontainer/devcontainer.json` referenziert
  zunächst ein Microsoft-Devcontainer-Base-Image. Das ist temporär.
- Die Egress-Whitelist und der non-root-Setup aus dem Archiv kommen
  erst mit Schritt 8 ins eigene Image. Bis dahin ist die Sandbox _nicht_
  vollständig abgesichert — bewusst akzeptiert für die Bauphase.
- `docs/backlog.md` wird passend zu dieser Reihenfolge aktualisiert; die
  ursprüngliche Tasks-Nummerierung bleibt nicht erhalten.
