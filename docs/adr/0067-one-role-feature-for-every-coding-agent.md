# ADR 0067: One role feature for every coding agent, and the session leads in all of them

- Status: accepted
- Date: 2026-11-08
- Supersedes in part: [ADR 0043](0043-opencode-roles-as-its-own-component.md)
  (the roles as one feature per agent, with deliberately copied prompts) and
  [ADR 0044](0044-claude-code-roles-the-session-leads-and-a-hook-holds-the-permissions.md)
  (the plans under `~/.claude/plans`)
- Relates to: [ADR 0018](0018-tool-freshness-model.md) (agent config is
  written at apply), [ADR 0020](0020-unified-component-descriptors.md)
  (persistent home paths), [ADR 0050](0050-a-design-role-does-not-earn-its-runtime.md)
  (the design role that was dropped)

## Context

The plan / implement / review roles shipped twice: `opencode-roles` (ADR 0043)
and `claude-code-roles` (ADR 0044). The two had to stay out of each other's
way. They used the same role names, and OpenCode also reads `~/.claude/skills/`,
so with both installed an OpenCode run picked up a Claude Code skill and ran it
on its default agent, without the role's guard. `apply` refused the
combination. With Copilot in the workbench and Codex possible, the approach
meant a third and a fourth copy of every prompt, and every lesson from a real
run carried by hand into each.

The copies existed because the control flow differed: the OpenCode planner was
a primary agent that drove the whole chain, while in Claude Code the session
led and the roles were subagents, because a Claude Code subagent cannot ask the
user anything. The second shape is the one every agent supports. Nothing
documents that a Copilot or Codex subagent can reach the user either.

The roles were also read as the way to work in Monoceros. People routed around
them for small changes, because a planner, a developer and a reviewer each
start cold on the same code. That cost is right for work worth a plan and
wrong for a small correction, where a plan costs more tokens and time than
the fix.

## Decision

**One feature, `agent-roles`, writes the roles for every coding agent in the
workbench**: Claude Code, OpenCode and Copilot today. It replaces both old
features.

**The session leads in every agent.** The three skills (`/agent-roles-plan`,
`/agent-roles-ship`, `/agent-roles-review`) run in the session, ask the user
there, and delegate to subagents (`agent-roles-planner`,
`agent-roles-developer`, `agent-roles-reviewer`) that write, implement or
review and never delegate further. The OpenCode planner no longer drives the
chain.

**One text, per-agent frontmatter.** The role bodies and the skills exist once
under `packages/cli/templates/agent-roles/`. What differs per agent is only how
a role is declared and how its permissions hold, in
`frontmatter/<agent>/<role>.yml`, and where the files go. The skills are
written into each agent's own skills directory with identical content, so
OpenCode finding the Claude Code copy as well is harmless; it prefers its own.
OpenCode gets a one-line command per skill, because it reaches skills through
its skill tool rather than as `/name`.

**The guard serves every agent.** One `guard.mjs`, called with the role and
the agent. Claude Code reads `hookSpecificOutput`; Copilot reads a flat
`permissionDecision` and also denies on exit code 2, so the guard writes both
forms for it and reads Copilot's tool names and argument shapes (`create`,
`edit`, `apply_patch`, arguments as a JSON string). OpenCode has no hook
command, so a plugin in `~/.config/opencode/plugins/agent-roles-guard.js` runs
the same script from `tool.execute.before` and turns its exit code 2 into a
refused call. That hook does not name the agent; `chat.params`, which runs
before every model call, does, and the plugin remembers it per session. A live
run in OpenCode 1.19.5 confirmed both: a reviewer subagent was named before its
first tool call, and the thrown reason reached the model.

OpenCode used to hold the roles with glob permissions alone. A glob compares
text, so it could not tell `> file` from `2>&1`, a quoted arrow, `>&2` or a `>`
in a heredoc body, and real runs were refused over each in turn. The globs that
a glob gets right (`edit: deny`, the plans directory, `git push`, `sed -i`) stay
in the agents as a fallback for an OpenCode that does not load the plugin; the
redirect rules moved into the guard. The opencode feature stays on its major
for the same reason: OpenCode itself moves to a new major only on an explicit
`opencode upgrade --major`, and a new major may rename the plugin hooks.

**Plans and guard live in the workspace**, under
`.monoceros/agent-roles/{plans,guard.mjs}`. Every agent already reaches the
workspace root without extra permissions, a plan written in one agent can be
shipped from another, and wiping `projects/` leaves the plans alone. The
developer may write anywhere except that directory, so the guard cannot be
edited away by the role it holds. Removing the feature removes the guard and
keeps the plans.

**Models and effort are set per role and per agent, in a `roles:` block.**
It sits next to `options:` on the feature entry, like `plugins:` on
`claude-code`, because feature options are flat by the devcontainer spec and
this block is read by Monoceros only. Its fields are `${VAR}` references, the
way a feature's credential is written:

```yml
- ref: ghcr.io/getmonoceros/monoceros-features/agent-roles:1
  roles:
    planner:
      claude-code:
        model: ${AGENT_ROLES_CLAUDE_PLANNER_MODEL}
        effort: ${AGENT_ROLES_CLAUDE_PLANNER_EFFORT}
```

Which models someone has depends on the person and their plan, not on the
project, so the values live in the env: in `monoceros-config.env` once for
every workbench, overridden by `<name>.env` for one. `init` and `add-feature`
write the block for the agents the workbench carries, and an agent added later
gets its lines then. The references go through the same path as every other
`${VAR}`: seeded blank into `<name>.env`, asked for when neither env file holds
a value, resolved at apply. A literal value in the yml works too and pins a
role for that workbench.

Grouped by role, so a role's settings for every agent sit together, and
OpenCode's variant sits next to the model it belongs to. A field that is
empty, or whose reference resolves to nothing, means the session's model and
effort. OpenCode falls back to the
`opencode` feature's model and takes a variant only together with a model of
its own, because an unknown variant is a model-resolution error there.
Copilot's agent files take a model but no effort, so a role's effort goes into
Copilot's `settings.json` as `subagents.agents.<agent-name>.effortLevel`, the
per-subagent setting behind its `/subagents` command.

Rejected first, one flat option per role that every agent reads, with the
agent guessed from the value's spelling: Copilot writes Claude models as
`claude-opus-4.5` and Claude Code as `claude-opus-4-5`, so a guess sent one
agent's value to the other. Rejected second, an `agent=value` list in the flat
option: a separator is a parse rule nobody sees, and the yml parser cannot
check it.

**The feature sets no model for anyone.** Whether someone works in an agent,
is signed in, or has the models of a family is not in the yml, and a default
that guesses is what this replaces. The shipped workbench templates
(`discovery-atlassian`, `agent-github`) carry the references for Claude Code,
not values.

**Each agent is checked in its own vocabulary at apply**, after the references
are resolved; a value from the env is reported under its variable and file. Claude Code's aliases
and effort levels are a closed set, so a typo stops the apply with a
suggestion; OpenCode needs `provider/model-id`; Copilot's effort levels are a
closed set too, its model names are not checked. A placeholder like `<copilot model>` stops the apply
for every agent. An unknown role or agent name is a parse error. Lines for an
agent the workbench does not carry are not checked and are reported as
ignored.

**The review works without a plan.** `/agent-roles-review` without an argument,
in a conversation that planned nothing, reviews the change against what the
conversation set out to do. The session writes down the goal, the decisions
and the base ref; the reviewer never sees the conversation. Findings go back to
the session, which fixes them when the user says so.

**The roles are positioned for handed-over work.** The developer's description
says it is only for a plan, never for an ordinary change, and the briefing line
says to make a change asked for in conversation directly. The lessons that hold
for any session (every check has to be able to fail, a page is checked by its
references, no unprobed environment facts) move into the general briefing,
because a session in conversation never reads a role prompt.

**The old features are read, not offered.** `claude-code-roles` and
`opencode-roles` leave the catalog. An existing yml that names one still works:
its flat options are translated into the `roles:` block under `claude-code` or
`opencode`, the roles are written under the new names, and `apply` prints the
two commands that switch over: `add-feature agent-roles` first, because it
writes the old entry's settings into the new entry as an active `roles:` block
and can only read them while the old entry is there, then `remove-feature` for
the old one. `init` and `add-feature` take either old name
and write `agent-roles`, and `remove-feature` finds the old entry by its name,
because scripts and plugins still name them. Their files under the old names are
removed by name on every apply, together with the design role's.

Rejected: keeping the copies and adding a third. Every rule from a real run
would have had to reach three files, and nothing would have enforced it.

## Consequences

- One change to a prompt reaches every agent, and one test suite pins it.
  CLAUDE.md's rule "into both role sets" is replaced by "into the shared
  text".
- Behaviour that only one agent has must be phrased so the others read past it
  (the Claude Design connector, `SendMessage` to continue a subagent). The
  skills name the agent where an instruction is agent-specific.
- The slash commands changed name: `/monoceros-plan` is `/agent-roles-plan`,
  and so on. Plans under `~/.claude/plans` and
  `~/.local/share/opencode/plans` are not migrated; they stay where they are and
  can be shipped by their full path.
- Copilot documents its hooks thinly. A live run confirmed that an agent's own
  hooks fire while it runs as a subagent: the planner's `create` outside the
  plans directory was denied with the guard's reason. The argument shapes of
  the other tools are read as documented, and the guard defers on anything it
  does not recognise.
- The OpenCode guard depends on two plugin hooks of OpenCode 1.x. If an update
  drops them, the plugin stops refusing, quietly, and only the coarse globs
  hold. No test in the release gate can see that, because it takes a model
  call. Staying on the major is what keeps that from happening unnoticed: the
  plugin API that renames the hooks belongs to OpenCode 2. Raising the major is
  a deliberate release, and before it a live run in a workbench checks the
  plugin by hand, one role with one allowed and one refused command. A
  scheduled canary against a free model was considered and left out: it guards
  a rare case whose worst outcome the globs already contain, at the price of a
  secret, rate limits and inconclusive runs.
- Codex is not covered. It reads `~/.agents/skills`, defines roles as TOML, and
  takes the same hook output as Claude Code with the role in `agent_type`, so it
  slots in as one more frontmatter set and one more layout entry.
- An unattended mode (story in, PR and board status out) builds on this and is
  a separate step ([#152](https://github.com/getmonoceros/workbench/issues/152)).
