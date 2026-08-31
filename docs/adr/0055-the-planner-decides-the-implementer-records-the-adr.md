# ADR 0055: The planner decides, the implementer records the ADR

- Status: accepted
- Date: 2026-08-31
- Relates to: [ADR 0043](0043-opencode-roles-as-its-own-component.md) (the two
  role sets as deliberate copies, pinned by a test in each suite)

## Context

Discovery produces a technical brief that records the decisions taken before the
build: the choice, the rejected alternative, and what the choice has to satisfy.
It is a snapshot. Decisions taken later, while building, had nowhere to go.
Overwriting the brief loses the history; leaving it alone lets it go stale
silently.

The obvious answer, an ADR skill that writes to Confluence next to the brief, was
rejected: a decision taken while implementing belongs in the same commit as the
change it explains and in the same review, and this repository already keeps its
own ADRs under `docs/adr/`. Sending the person who changes the code out of the
repository to record why is how the record stops being written.

That leaves the question of which role owns it, and the guard answers it. The
planner's write permission covers the plans directory only, enforced by a hook,
because the plan is the contract and a planner that edits code has stopped being
a planner. So the role that takes the decision cannot create the file.

## Decision

The duty is split along the permission that already exists.

The **planner** reads `docs/adr/` before planning. A decision recorded there is
settled and is not reopened; overturning one has to be stated in the plan with
the ADR named by number. Where the plan takes a decision whose consequences reach
past the change, the plan carries **a numbered step that writes the ADR**, with
the number probed from the directory and the full content inlined, so the
implementer copies rather than composes.

The **implementer** executes that step like any other and commits the file with
the change it explains. Where it had to decide something the plan did not cover,
it does **not** write an ADR: it names the decision in its deviations. A record
that later readers treat as settled must not fill up with decisions nobody
reviewed.

The **reviewer** checks that a planned ADR exists and carries its number, and
treats a reported decision without one as a finding.

Not every change earns an ADR. The test is whether a later reader would ask why
it is built this way and find no answer.

## Consequences

The prompts carry the rule, so it costs nothing at runtime and applies to every
project a workbench builds, not only to this repository.

It is duplicated across both role sets, as ADR 0043 requires, and pinned by one
test per suite. Nothing but those two tests enforces the overlap.

An unwelcome part: the planner has to probe the next number, and two plans
written in parallel can pick the same one. That is a collision the implementer or
the reviewer sees in the diff, and it is cheaper than a numbering service.

And the brief stays a snapshot on purpose. Its technology decisions now carry an
italic line saying so and pointing here, which is the only place the two
mechanisms touch.
