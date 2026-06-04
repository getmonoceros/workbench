# ADR 0014 — AI Tool Briefing at the Container Workspace Root

- Status: accepted
- Date: 2026-06-04

## Context

AI coding tools in the container (Claude Code, OpenCode, and down the
road Codex, Gemini CLI, GitHub Copilot) don't know out of the box what
kind of stack was materialized in the container. A container tailored
for Java risks Claude building a Node backend unprompted, because it
doesn't know which languages, services, and helper commands are
available to it.

The information already exists in the yml and in the installed
devcontainer features. It needs to be present in a form that the AI
tools read automatically on session start — without the builder having
to explain it per session.

Each tool has its own conventions for instruction files:

| Tool           | File                               | Lookup                                   |
| -------------- | ---------------------------------- | ---------------------------------------- |
| Claude Code    | `CLAUDE.md`                        | Walk-up from cwd to filesystem root      |
| OpenCode       | `AGENTS.md` (fallback `CLAUDE.md`) | Walk-up from cwd to filesystem root      |
| Codex          | `AGENTS.md`                        | git root down to cwd (no walk-up)        |
| Gemini CLI     | `GEMINI.md`                        | Walk-up to "trusted root" (fuzzy)        |
| GitHub Copilot | `.github/copilot-instructions.md`  | Workspace root only, buggy in multi-root |

On top of that there are managed-policy slots at system-level paths
(`/etc/claude-code/CLAUDE.md`, `/etc/codex/requirements.toml`) that
companies deploy to the host via MDM. Those slots belong to the org,
not to us — Monoceros must not overwrite them, otherwise the workbench
becomes a policy bypass.

## Decision

Monoceros places the container briefing **at the container workspace
root next to the `.code-workspace` file**, not in system paths and not
in project directories. Concretely:

```
container/<name>/
├── .devcontainer/
├── .monoceros/
│   ├── state.json
│   └── commands.md        ← CLI reference, @-imported by AGENTS.md
├── home/
├── logs/
├── projects/
│   └── <projekt>/         ← project repos, untouched
├── sandbox.code-workspace
├── AGENTS.md              ← canonical content (inside markers)
└── CLAUDE.md              ← @AGENTS.md (inside markers)
```

**`AGENTS.md`** is the source of truth: it contains the stack manifest
(languages, services, connection hints), a note about the declarative
model, and the three extension commands (`monoceros add-feature`,
`add-service`, `apply`) as instructions to the user — not to the tool,
which can't run anything on the host itself.

**`CLAUDE.md`** imports `@AGENTS.md`. This is the mechanism recommended
in the Claude Code docs for AGENTS.md coexistence, and it avoids
content duplication. OpenCode reads both files directly and would get
by without this stub.

**`.monoceros/commands.md`** is the per-subcommand reference, generated
from the citty definitions in `commands/*.ts`. `AGENTS.md` pulls it in
via `@.monoceros/commands.md` — so the AI tool session can look up the
exact command syntax before making a suggestion.

Both marker-bearing files (`AGENTS.md` and `CLAUDE.md`) are wrapped in
the HTML-comment markers `<!-- monoceros:begin -->` /
`<!-- monoceros:end -->`. Apply replaces **only** the content between
the markers. Whatever the builder writes outside the markers (their own
notes, project-specific reminders) is preserved.
`.monoceros/commands.md` is 100% Monoceros-owned and is always
rewritten in full.

## Rationale

- **Walk-up hits both primary tools.** Claude Code and OpenCode walk up
  from the cwd in a project under `projects/<name>/` to the filesystem
  root and automatically find the file one level above `projects/`. One
  file, two tools, no symlinks into the project.
- **No policy bypass.** The system slots `/etc/claude-code/CLAUDE.md`
  and `/etc/codex/requirements.toml` stay untouched. If an org deploys
  these paths to the host via MDM, the container build pipeline can
  propagate them into the container unchanged (a separate decision, not
  part of this ADR), without the Monoceros briefing coming into
  conflict.
- **No writes into project directories.** `projects/<name>/` is user
  territory — its own git, its own `.gitignore`, possibly its own
  `CLAUDE.md`. Monoceros does not write there. If a project ships its
  own `CLAUDE.md`, it is loaded via walk-up _in addition to_ the
  Monoceros briefing — Claude Code and OpenCode concatenate both.
- **The host filesystem is not affected.** The `container/<name>/`
  structure exists on the host as a materialized directory; inside the
  container it is mounted at the workspace root. AI tools read the
  briefing only inside the container.
- **`AGENTS.md` as the canonical name** is the convergence bet: the
  open standard that Codex and OpenCode read natively, that the Copilot
  cloud agent reads too, and for which Claude Code documents an official
  import mechanism. A `GEMINI.md` symlink would be trivial to add once
  Gemini support is prioritized.

## Consequences

- On `apply`, Monoceros generates `AGENTS.md`, `CLAUDE.md`, and
  `.monoceros/commands.md` in the container directory. The content of
  `AGENTS.md` is derived deterministically from the yml and the
  installed features; `commands.md` from the citty definitions of the
  currently running CLI version.
- `AGENTS.md` and `CLAUDE.md` are added to the generated `.gitignore`
  in the container directory (`.monoceros/` was already in there and
  covers `commands.md` automatically) — in case the directory itself
  ever ends up under version control, Monoceros files don't belong
  there.
- **Marker contract** on `AGENTS.md` and `CLAUDE.md`: the block written
  by the generator sits between `<!-- monoceros:begin -->` /
  `<!-- monoceros:end -->`. Re-apply replaces only that block; user
  additions before/after survive. The Claude Code docs strip HTML
  comments before context injection, so there's no token surcharge for
  the markers themselves.
- **Manifest-driven feature briefings**:
  `x-monoceros.briefing.lines` in `devcontainer-feature.json` with
  optional `whenOption` gating. The generator merges manifest defaults
  with user options and emits only lines that resolve truthy against
  each other. A feature with a briefing block but no matching line is
  silently omitted — no "tool installed" when none is running.
- **No credentials in the briefing** — neither dev defaults from the
  service catalog nor values from the `.env`. The briefing instructs
  the AI tool to ask the user during the running session if it needs
  credentials. That keeps the file non-sensitive even when it leaves
  the local machine as a screenshot/paste.
- The briefing generation module (deriving the stack manifest from the
  yml) is testable as its own component, independent of the apply
  subprocess — see `packages/cli/src/briefing/`.
- **Codex, Gemini CLI, and GitHub Copilot remain blind spots today.**
  They don't see the briefing via the walk-up mechanism. This is
  consciously accepted; solutions are documented (see below) and await
  prioritization.

### Open items (for later)

- **Codex** — `~/.codex/AGENTS.md` as a global user slot in the
  container home would be the obvious path to test for real.
- **Gemini CLI** — `~/.gemini/GEMINI.md` analogously. Verify the
  "trusted root" definition against the Gemini CLI source.
- **GitHub Copilot** — a genuine special case: needs a per-project file
  (`.github/copilot-instructions.md`) or a workspace-root file
  depending on open-folder vs. multi-root. A solution requires write
  access to projects or an activatable per-project yml switch.
- **Service-side briefing manifest** — features have been
  manifest-driven since implementation (`x-monoceros.briefing`); for
  curated services, analogous fields in the `SERVICE_CATALOG` or in the
  component yamls could become useful once practice calls for it. Today
  the hardcoded service render path in the generator is enough.

## Rejected

- **Using `/etc/claude-code/CLAUDE.md` in the container** — technically
  possible (the container has its own `/etc/`, no host MDM there), but
  that is the slot where companies deploy policies. Writing Monoceros
  into that path turns the workbench into a policy-bypass tool in an org
  context. Unacceptable as a default.
- **Symlinking/copying the briefing file per project** — would
  additionally cover Codex and Copilot, but writes into every project
  directory. Conflict with a project's own `CLAUDE.md`, `.gitignore`
  acrobatics, the risk of Monoceros files getting checked into foreign
  repos. Per-tool, per-project opt-in via the yml would be conceivable,
  but is a follow-up decision.
- **A `.code-workspace`-like file _inside_ the project directory** —
  the same conflict as above, plus a collision with a project's own
  `.code-workspace` files.
- **Writing to `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` /
  `~/.gemini/GEMINI.md` in the container home as a default** — works
  independently of the cwd, but collides with user globals that the
  user may want to maintain themselves (`~/.claude` is also bind-mounted,
  see ADR 0003). As a workaround for the tools not covered today, the
  slot remains an option (see Open items), but not as the default
  mechanism for the container briefing.
