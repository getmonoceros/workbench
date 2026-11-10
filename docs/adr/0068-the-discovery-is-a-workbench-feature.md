# ADR 0068: The discovery is a workbench feature, for every coding agent, and runs only in a workbench

- Status: accepted
- Date: 2026-11-10
- Relates to: [ADR 0053](0053-agent-plugins-are-installed-by-the-agents-own-cli.md)
  (agent plugins in the yml, which shipped the discovery until now),
  [ADR 0067](0067-one-role-feature-for-every-coding-agent.md) (the mechanism
  this reuses), [ADR 0018](0018-tool-freshness-model.md) (agent config is
  written at apply), [ADR 0019](0019-component-taxonomy-service-feature-dependency.md)
  (what a feature is), [ADR 0045](0045-mcp-servers-as-catalog-components.md)
  (the `monoceros-docs` server it relies on)

## Context

The discovery skills (brief, personas and journeys, domain model, design,
technical frame, planning, handoff) shipped as the Claude Code plugin
`discovery-atlassian` from the separate `monoceros-discovery` repository. A
workbench got them through a `plugins:` block on the `claude-code` entry
(ADR 0053). Three things were wrong with that:

- Only Claude Code got them. Since ADR 0067 the roles serve OpenCode and
  Copilot too, so a workbench on either could work the backlog but not run the
  discovery that fills it.
- The builder wrote the block by hand. No command writes a nested block under
  a feature entry.
- The skills lived apart from the CLI they describe. The technical frame
  writes `monoceros init` commands and follows the CLI's rules for templates,
  ports and repos, so a CLI change there needed a matching plugin release,
  and the two drifted.

Two other ways were considered. A generic `agentPlugins:` block, with
`add-agent-plugin` cloning any Claude-format marketplace and copying its
skills to OpenCode and Copilot, would have served exactly one plugin: the
discovery is the only one Monoceros has. Supporting the discovery outside a
workbench too (claude.ai, the Claude desktop app, the GitHub Copilot app)
would have kept a second Atlassian path in the skills, through an MCP
connector, next to `twg`, and the diagrams of the domain model and the
technical brief cannot be rendered and uploaded without a shell anyway.

## Decision

**The discovery is the feature `discovery-atlassian`, built the way
`agent-roles` is.** It installs nothing into the image. At apply, Monoceros
copies the seven skills, host-side, into the persistent skills directory of
every coding agent in the workbench: `~/.claude/skills/`,
`~/.config/opencode/skills/` and `~/.copilot/skills/`. OpenCode also gets a
one-line command per skill, because it reaches a skill through its skill tool
and not as `/name`. `monoceros add-feature <name> discovery-atlassian` is how a
workbench gets it, and the `discovery-atlassian` workbench template carries it.

**One text, in the workbench repo.** The skills live under
`packages/cli/templates/discovery-atlassian/`. A skill reads only from its own
directory, so the files several skills share (the discovery rules, the
Confluence style, `diagram.mjs` and its fonts) are kept once under `shared/`
and copied into each skill that needs them when apply writes it. That replaces
the plugin repository's `sync-shared.sh`. A skill change ships with a CLI
release, like any other template.

**The discovery runs only in a workbench.** That is where `twg` writes to
Confluence and Jira, where the diagrams are rendered and uploaded, and where a
product owner works in the same environment as the developers. Someone who
prefers a desktop app attaches Claude Desktop to the workbench over SSH
([ADR 0022](0022-ssh-universal-ide-attach-point.md)). The skills therefore
know one Atlassian path, `twg`, and the upload path through the MCP connector
is gone.

**The skills ask without naming a tool.** They used to say "use
AskUserQuestion". Now they say "ask, as a choice", the way the `agent-roles`
skills do, and each agent asks its own way.

**What the discovery needs and does not have is named, not enforced.** Apply
prints the command for each missing piece and carries on: a coding agent,
`atlassian` with `twg`, and the `monoceros-docs` MCP server the technical
brief reads the catalog from (matched by name or by its URL). A workbench
that still has the old plugin is told to switch over; one that has both is
told that Claude Code now sees every skill twice and which entry to delete.

**The plugin is deprecated, not removed at once.** `monoceros-discovery` keeps
`discovery-atlassian` unchanged until this feature is released. Then its README
and every one of its skills carry a deprecation notice with a removal date,
and on that date the plugin leaves `marketplace.json`. `quickstart` stays a
plugin there: it runs before any workbench exists.

## Consequences

- One change to a discovery skill reaches all three agents, in the same
  commit as the CLI change it follows, and the tests in
  `discovery-atlassian.test.ts` pin where each file lands.
- The discovery is no longer available on claude.ai or in a desktop app
  without a workbench. That is deliberate; the price is the setup a product
  owner needs once.
- `plugins:` and ADR 0053 stay as they are. A generic block for plugins of
  every agent is parked until a second plugin needs it.
- OpenCode reads `~/.claude/skills/` as well, so in a workbench with Claude
  Code and OpenCode it finds each skill twice, with identical content. As with
  the roles, that is harmless: it prefers its own.
- The skills are prose for a model, so prettier and eslint leave
  `packages/cli/templates/discovery-atlassian/` alone, as they do for the
  roles.
