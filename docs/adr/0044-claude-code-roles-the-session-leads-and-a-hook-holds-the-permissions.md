# ADR 0044: For Claude Code roles the session leads, and a hook holds the permissions

- Status: accepted
- Date: 2026-08-02
- Relates to: [ADR 0043](0043-opencode-roles-as-its-own-component.md) (the same
  workflow for OpenCode, and why a workflow may ship as a component at all),
  [ADR 0018](0018-tool-freshness-model.md) (why agent config is written at apply
  instead of baked into a cached layer),
  [ADR 0020](0020-unified-component-descriptors.md) (persistent home paths)

## Context

ADR 0043 shipped `opencode-roles`: a planner that turns a task into a plan file
and writes no source, an implementer that executes that plan, and a reviewer
that checks the result against it. It also said what should happen if the split
proved itself elsewhere:

> A second AI agent (Claude Code, Codex) does not get these roles. If the same
> split proves itself there, it is a sibling component, not an option on this
> one.

This is that sibling. The prompts carry over almost unchanged, because what a
day of measurement bought is in the prose: phase 0 with one question at a time
and a recommended answer, the plan file as the contract, the approval gate
before anything runs, gating the review on a green acceptance command, at most
two repair rounds with an early stop when a finding survives, and a reviewer
that establishes facts before it judges.

What does not carry over is the machinery underneath. Three of Claude Code's
constraints decide the shape, and each one was checked against the current
documentation rather than assumed.

**Subagents cannot ask the user anything.** Claude Code removes
`AskUserQuestion` from every subagent. The skill-level `context: fork` does not
change that: the documentation is explicit that a forked skill runs as a regular
agent type, so the exemption for conversation forks does not cover it. Phase 0
is a dialogue, and a role that cannot ask cannot conduct one.

**Skill-level restrictions expire after one turn.** A skill's `model`,
`allowed-tools` and `disallowed-tools` apply for the turn that invoked the
skill and are gone the moment the user replies. A planning dialogue spans many
turns, so a planner built as a skill would lose both its model and its guard
rails after the first answer.

**`permissionMode` is ignored in Auto Mode.** OpenCode expresses each role's
boundaries as glob rules per tool (`edit: { '*': deny, '<plans>/*': allow }`).
Claude Code has no such rules. It has `tools` and `disallowedTools`, which
remove a tool wholesale and cannot express "may write the plan file and nothing
else", and it has `permissionMode`, which the documentation says is ignored
outright when the session runs in Auto Mode. Auto Mode is the `claude-code`
feature's own default. So the two obvious mechanisms cover neither the shape of
the rules nor the mode most containers run in.

## Decision

**The roles ship as their own component, `claude-code-roles`**, on the same
reasoning as ADR 0043: adding it to the yml is what turns the workflow on, and
not adding it leaves the workbench as agnostic as before. Three options, one
per role, no baked-in model defaults. The files are written at apply, host-side,
into `<container-dir>/home/.claude/`, because that path is a persistent-home
bind mount owned by the `claude-code` feature and a layer would be shadowed.

Beyond that, three decisions that have no counterpart on the OpenCode side.

**The session leads; a subagent never delegates.** `/monoceros-plan` runs in the
session, asks phase 0 there as real turns, and hands the answers to the
`monoceros-planner` subagent, which writes the plan and reports back.
`/monoceros-ship` runs in the session too and calls `monoceros-implement`, then
`monoceros-review`. Both are one level down, so the chain never touches Claude
Code's subagent nesting limit, whose default changed twice in three releases.
Neither `context: fork` nor `background: false` is used, so nothing here depends
on a version younger than the roles themselves.

This turns out better than a translation would have been. The dialogue runs in
the session, where it is cheap, and the role's own model is spent only on the
work. The approval gate lands where it belongs: between `/monoceros-plan` and
`/monoceros-ship`, with the user in between, rather than inside one agent's
control flow.

**Permissions come from a PreToolUse hook.** A single script, `guard.mjs`,
written next to the agents and wired into all three with the role as its
argument. It reads the hook event and denies what the role must not do: the
planner writes only under the plans directory, the implementer writes anything
except the plan it is measured against, the reviewer writes nothing. Each role
also carries a short shell denylist, so a redirect, a heredoc, `tee` or `sed -i`
cannot route around the write rule, and so nothing leaves the machine.

A hook is the only layer that holds. `tools`/`disallowedTools` still do their
part where the rule is "this tool, never" (the reviewer has no Write or Edit,
none of the agents has `Agent`), but a hook `deny` is honoured in every
permission mode, including the Auto Mode the feature defaults to. The script
defers rather than denying on anything it does not recognise: a guard that
blocks everything looks exactly like a broken agent.

**Plans live in `~/.claude/plans/<app>/<slug>.md`.** Inside the directory the
`claude-code` feature already persists, so a plan survives an apply and survives
wiping `projects/`, which is what a builder does between runs. Not in the
project, for the same reason as on the OpenCode side.

## Consequences

- The two role sets stay separate copies, as ADR 0043 said they would. They now
  differ in more than prose: the OpenCode planner drives its own chain, the
  Claude Code one only writes. A shared template would have to satisfy both and
  would serve neither.
- The permission layer is code, so it is tested as code. `guard.mjs` is
  exercised as a real process against real hook JSON, one case per rule, rather
  than asserted on as a string. It is the part most likely to be wrong, and on
  OpenCode the equivalent took three attempts and a container log to get right.
  It took one here too: the first real run denied sixteen of the planner's
  probes, because the redirect rule was copied across as `>>?\s*\S` and that
  also matches `2>&1` and `2>/dev/null`. Redirecting stderr writes nothing. The
  rule now excludes both, and the sixteen commands are a test.
- **Only `/monoceros-plan` blocks model invocation.** The same run ended with
  the user saying "let's implement it" and the session unable to reach
  `/monoceros-ship`, because every skill carried
  `disable-model-invocation: true`. The entry point keeps it, so a planning
  dialogue is never started unasked. The two steps after an approved plan do
  not: by then the user has read the plan and said yes, and that approval is
  the gate, not the invocation mechanism.
- The roles depend on the `claude-code` feature being in the same container. The
  component warns when it is not and writes the files anyway: a feature in the
  yml with nothing on disk is the worse failure.
- A builder who customises a role copies the file into a project's
  `.claude/agents/` or `.claude/skills/`, which wins over the global one and is
  theirs to keep. Every generated file says so.
- If Claude Code later lets a subagent reach the user, the planner could take
  its own dialogue back. Nothing here would have to move: the skill would shrink
  and the agent would grow.
