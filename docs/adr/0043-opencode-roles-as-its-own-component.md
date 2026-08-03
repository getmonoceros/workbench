# ADR 0043: A plan/implement/review workflow ships as its own component, not inside the workbench

- Status: accepted
- Date: 2026-07-31
- Relates to: [`docs/concept.md`](../concept.md) ("no iteration workflow"),
  [ADR 0019](0019-component-taxonomy-service-feature-dependency.md) (what
  becomes a component), [ADR 0020](0020-unified-component-descriptors.md)
  (the descriptor a component is built from),
  [ADR 0018](0018-tool-freshness-model.md) (why agent config is written at
  apply instead of baked into a cached layer)

## Context

Three OpenCode agents came out of a week of real use: a **planner** that turns
a task into a plan file and writes no source, an **implementer** that executes
that plan, and a **reviewer** that checks the result against it. Measured
against a single agent doing all three, the split found skipped steps, kept a
cheap model usable for the bulk of the work, and made the handoff inspectable -
the plan file is the contract.

That is a workflow. And `docs/concept.md` says, in the list of what Monoceros
is not:

> **no iteration workflow** — no plan/generate/review pipeline; if something
> like that comes, it comes as a separate project that builds on top of the
> workbench

The obvious move was to hang the roles off the existing `opencode` feature as
an option group. Three things argue against it:

1. **It puts a working-style opinion into the frame.** Everyone who installs
   `opencode` would carry the workflow's option surface, whether they want the
   roles or not. The workbench would stop being agnostic about how you work.
2. **Release cadence.** The prompts are the part that changes most - this
   week's run alone rewrote them four times. Every tweak would be a release of
   the feature that every OpenCode user pulls.
3. **The option shape does not exist.** Feature options are a flat map of
   `string | number | boolean | null` (the devcontainer spec has no nested
   objects either), so `roles: { enabled, plannerModel, … }` is not
   expressible. It would become `rolesEnabled`, `rolesPlannerModel`, … on a
   feature that most people use for one thing.

## Decision

**The roles ship as their own component, `opencode-roles`.** Adding it to the
yml is what turns the workflow on; not adding it leaves the workbench exactly
as agnostic as before. The concept boundary holds, in the reading that matters:
the workbench frames, the workflow is a part you choose.

Three options, one per role (`plannerModel`, `implementModel`, `reviewModel`),
each falling back to the `opencode` feature's own `model` and then to whatever
OpenCode would pick. **No baked-in model defaults**: model ids age faster than
releases, and a stale default in a shipped feature is worse than none.

**Names carry a `monoceros-` prefix** — the agents `monoceros-planner`,
`monoceros-implement`, `monoceros-review`, the commands `/monoceros-plan`,
`/monoceros-ship`, `/monoceros-review`. OpenCode's agents and commands are one
flat global namespace per container, a custom command silently overrides a
built-in one, and `/plan` or an `implement` agent is exactly what a builder
writes for themselves. An unprefixed name would collide without a word.

**The files are written at apply, host-side**, into
`<container-dir>/home/.config/opencode/{agents,commands}/`, and the feature's
`install.sh` deliberately installs nothing. `~/.config/opencode` is a
persistent-home bind mount owned by the `opencode` feature (ADR 0020): a file
baked into an image layer there is shadowed the moment the container starts.
Same reason `opencode.json` is written at apply rather than into a cached
layer (ADR 0018).

The prompts live as markdown under `packages/cli/templates/opencode-roles/`
with two placeholders (the `model:` line and the plans directory), so they stay
readable and diffable instead of hiding inside string literals.

**Plans are written to `~/.local/share/opencode/plans/`**, OpenCode's own data
directory, which the `opencode` feature persists. Not into the project: a plan
survives an apply and survives wiping `projects/`, which is what the builder
does between runs.

## Consequences

- Every generated file says it is regenerated on the next apply and names the
  supported way to customise a role: a project-level `.opencode/agents/<name>.md`
  wins over the global one and is the builder's to keep.
- The component warns when `opencode` is absent from the same container, and
  writes the files anyway - a feature in the yml with nothing on disk is the
  worse failure.
- A second AI agent (Claude Code, Codex) does not get these roles. If the same
  split proves itself there, it is a sibling component, not an option on this
  one. That happened: `claude-code-roles` is that sibling
  ([ADR 0044](0044-claude-code-roles-the-session-leads-and-a-hook-holds-the-permissions.md)),
  and rules learned on one side are now carried to both.
- **An acceptance command that cannot fail is worse than none**, and this
  workflow makes that failure easy to reach: the planner writes the command, the
  implementer runs it, and the reviewer runs it again, so all three inherit
  whatever the first one got wrong. A real run asked for a web app, and every
  check for "the app is reachable" was a 200 on `/`. A dev server returns the
  page shell whether the app loads or not, so the command was green while the
  browser showed a white page. Fifteen tests, a plan that even probed the API
  proxy, and a reviewer that read all 27 files did not catch it, because none of
  them fetched what the page referenced. All three roles now carry the rule that
  a served page is checked by following its references, and the planner is told
  to put that into the command rather than only into the criteria - the command
  outlives the run.
- The concept document stays as it is. This ADR is the record that the boundary
  was tested and where it was drawn: a workflow may ship **as a component**,
  and the workbench itself still has no opinion on how you work.
