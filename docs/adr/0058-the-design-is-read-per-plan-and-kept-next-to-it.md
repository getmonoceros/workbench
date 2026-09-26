# ADR 0058: The design is read per plan and kept next to it

- Status: accepted
- Date: 2026-09-25
- Relates to: [ADR 0043](0043-opencode-roles-as-its-own-component.md) (the two
  role sets as deliberate copies, pinned by a test in each suite),
  [ADR 0055](0055-the-planner-decides-the-implementer-records-the-adr.md)
  (duties split along the guard's write permission)

## Context

Planning in the discovery plugin gives every story a Design section that links
the prototype. None of the roles was told to read it. When the link did not
open, the run carried on without the screens, and nobody noticed.

For a Claude Design link, not opening is common. Reading one needs design scopes
on the claude.ai login. `/design-login` adds them, and a later `/login` or token
refresh can drop them again
([anthropics/claude-code#92215](https://github.com/anthropics/claude-code/issues/92215)).
Monoceros cannot fix that. What it can do is fail loudly, at a point where the
user can still fix it, and make sure the access is needed only once per plan.

## Decision

The **lead**, the one role that talks to the user (the `/monoceros-plan` skill
on Claude Code, the planner itself on OpenCode), reads the design before the
first question. It tells the source by the link's host and reads it through the
tool made for that source, never a plain web fetch. If it cannot, it stops and
plans nothing, and names the link and the fix for its source:

- **Claude Design:** `/design-login` and a rerun on Claude Code. OpenCode has no
  way in, so there it is an export.
- **Figma and Figma Make:** the catalog's `figma` connector, which reads both. A
  workbench without it gets the host step `monoceros add-mcp-server <name>
figma` plus `apply`; a connector that is not signed in gets `/mcp` on Claude
  Code or `opencode mcp auth figma` on OpenCode. Whether the workbench has the
  connector is decided by the briefing (`AGENTS.md`, "MCP servers"), not by the
  tools a session shows. A connector that comes with the user's claude.ai
  account (`claude.ai Figma`) does not count: the yml is the source of truth for
  what the container connects to, and in a real run the account's connector hid
  that the workbench had none.
- **Anything else:** an unpacked export of the prototype the planner can read.

The **planner** saves what it read under `<plans>/<app>/<slug>.design/`, fresh
for every plan, and the plan gets a Design section listing the saved files, the
screen each one shows, and the steps that build it.

The **implementer** and the **reviewer** work from that copy and never open the
link. A missing copy, or a screen the copy does not cover, stops the
implementer.

The copy is kept out of the project repository. We rejected committing the
design into the repository: the prototype keeps changing, and a second copy in
the repository drifts away from it. Next to the plan, the copy is exactly the
version that plan was written against, and the next plan takes a new one.

## Consequences

Only one read per plan needs the claude.ai access, and it happens in the session
where the user can run `/design-login`. The subagents after it work offline.

A plan with a design cannot be written without access to it. That is on purpose,
and it also blocks a run in which the design would only have been nice to have.

The copy is as good as what the planner chose to save. A screen it left out is a
screen the implementer stops on, which is loud but costs a rerun.

The rule is duplicated across both role sets, as ADR 0043 requires, and pinned by
one test per suite.
