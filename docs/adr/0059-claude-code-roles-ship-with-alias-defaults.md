# ADR 0059: Claude Code roles ship with alias defaults

- Status: accepted
- Date: 2026-09-27
- Relates to: [ADR 0043](0043-opencode-roles-as-its-own-component.md) (no
  baked-in model defaults for the OpenCode roles)

## Context

ADR 0043 ships the OpenCode roles without model defaults, because a model id
ages faster than a release and a stale default is worse than none.
`claude-code-roles` copied that rule and left all six options empty. So a fresh
workbench ran all three roles on the session's model and effort, which nobody
had chosen. In one run all three sat on `high` by inheritance, and the reviewer
alone accounted for almost 40 percent of the cost.

The reason behind ADR 0043 does not carry over. The OpenCode roles take
`provider/model-id` strings, and those do age. The Claude Code roles take the
aliases `opus`, `sonnet`, `haiku` and `fable`, which Claude Code resolves to the
current model of each family.

## Decision

The `claude-code-roles` descriptor defaults to `opus` with `high` effort for the
planner and the reviewer, and `sonnet` with `medium` effort for the implementer.
The defaults are `surface: yml`, so `init` and `add-feature` write them into the
yml. They are never applied at apply time: the yml stays the one place that says
what a role runs on, and an empty value still means the role inherits the
session's model or effort.

ADR 0043 stands for the OpenCode roles, which keep empty defaults.

## Consequences

A new workbench splits the work sensibly from the first run, without the builder
having to know which model fits which role.

Existing workbenches keep the empty values their yml already carries, and pick up
the defaults only when the feature is removed and added again.

If an alias ever stops resolving, the fix is a descriptor change and a CLI
release, the same as for any other catalog default.
