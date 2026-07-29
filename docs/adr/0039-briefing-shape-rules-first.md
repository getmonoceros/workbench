# ADR 0039: The generated briefing puts rules first and imports its long chapters

- Status: accepted
- Date: 2026-07-29

## Context

ADR 0014 settled where the briefing lives and that `AGENTS.md` is the canonical
file. It did not settle what the file looks like from the top down, and that
turned out to matter more than the content.

A live test on Windows produced a project compose file written from memory:
wrong image tags, invented variable names, no healthcheck. The agent had read
the briefing with `cat AGENTS.md | head -100`, treated that as the whole file,
and never said it had truncated anything. It missed the conventions, the
long-running-server rules and the `@.monoceros/deploy.md` import.

The shape is what enabled it. Measured on a small workbench (node, keycloak,
postgres, claude-code), 252 lines:

| Section                           | Lines |
| --------------------------------- | ----- |
| What Monoceros is                 | 31    |
| What is here                      | 50    |
| How to extend this container      | 21    |
| Conventions and pitfalls          | 45    |
| Running a long-running server     | 72    |
| Taking the services to a pipeline | 11    |
| Command reference                 | 9     |

The first ~100 lines were background and inventory and contained no
behaviour-changing rule. Everything actionable sat after them, so an agent that
read the first 100 lines got exactly the part that told it nothing.

More instructions would not have fixed that. `@`-imports, on the other hand,
worked in that same run: Claude Code pulls them into context itself. The length
was the problem, not the mechanism.

## Decision

The generated briefing is ordered so that a partial read loses background, not
rules:

1. **Header with the file's shape** - the line count and the list of imports,
   both generated. An agent that read 100 lines of a file announcing 195 has a
   visible contradiction in front of it. The count is resolved on the finished
   file, markers and user notes included, so it matches what `wc -l` reports.
2. **Rules block**, one line per rule, right under the header: build under
   `projects/`, register a project in `<name>.code-workspace`, repo content in
   English, service credentials from the environment, a server needs an exposed
   port plus `.monoceros/launch.json` and must listen on `0.0.0.0`, start it
   with `monoceros-ctl`, take the pipeline compose from `.monoceros/deploy.md`,
   nothing installed from inside persists, host commands are the user's to run.
3. **Inventory** - what is actually in this container.
4. **Explanations** - the Monoceros model, how to extend the container.
5. **Imports** - the long chapters, each behind a short pointer.

The two long chapters move out into generated, Monoceros-owned files:
`.monoceros/conventions.md` (the former "Conventions and pitfalls") and
`.monoceros/servers.md` (the former "Running a long-running server" plus the
dev-server proxy rules, which used to hide inside the port inventory). Their
rules stay in the block above as one-liners, so a reader who never follows an
import still has the behaviour. Nearly every app in a workbench serves a port,
so the server rules are core material, not a special case.

## Consequences

- Every new import carries bookkeeping in `create/opencode-config.ts`:
  OpenCode does not follow `@`-imports, so a briefing file it should see has to
  be listed in `managedInstructions`, and in `everManaged` so a stale entry is
  removed once the file is gone. Claude Code needs no entry.
- The briefing states a number about itself. It is generated from the final
  file, not maintained by hand, so it cannot drift - but a caller that writes
  `AGENTS.md` without going through `writeBriefing` would leave the placeholder
  in place.
- Rules now exist twice: as a one-liner in the block and in long form in a
  chapter. That is the point, and it means a rule change touches both.
- The rules the briefing states can be partly verified after the fact, which is
  what `monoceros check` does (ADR 0040).
