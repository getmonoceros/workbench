# ADR 0047: Which MCP servers earn a curated connector

- Status: accepted
- Date: 2026-08-05
- Context: [ADR 0045](0045-mcp-servers-as-catalog-components.md) made an MCP
  server a catalog component. [ADR 0046](0046-an-oauth-mcp-server-is-read-from-the-endpoint.md)
  made an interactive sign-in expressible. Neither says which servers belong in
  the catalog.

## Decision

A server earns a curated connector when it gives an agent reach that **no CLI
already in the container has**, and when that reach closes a step an
unsupervised run otherwise stops at. Everything else stays out and goes in as an
inline `mcpServers:` entry, which needs no catalog change at all.

The curated set, with what each one is for:

| Connector         | Reach                                            | Auth  |
| ----------------- | ------------------------------------------------ | ----- |
| `context7`        | current API surface of the libraries in use      | key   |
| `rovo`            | Jira issues and Confluence pages                 | oauth |
| `notion`          | requirements written in Notion                   | oauth |
| `linear`          | Linear issues, projects, cycles                  | oauth |
| `figma`           | layout, components and design tokens of a design | oauth |
| `forge`           | Forge modules, manifest rules, UI Kit            | none  |
| `microsoft-learn` | first-party .NET and Azure docs and code samples | none  |

## Consequences

**A server whose reach a CLI already offers is not a connector.** `gh` covers
GitHub's whole REST surface, `psql` covers Postgres, `stripe` covers Stripe. A
second path to the same system costs tokens on every session and buys nothing.
This is the rule that keeps the catalog small, and it is why the set above has
no tracker that ships a CLI.

Where a CLI covers the reach, the CLI is the better component: it stays inside
the container and costs no context until it is called.

**A CLI and a connector for the same system can both be right, when they cover
different halves.** Notion is the case that shows it. `ntn pages get` returns a
page as Markdown, `ntn pages create` and `pages edit` write one, and
`ntn datasources query` filters and sorts a database, so everything an agent
does with a page it can already point at is CLI work. What `ntn` has no command
for is finding that page: `notion-search` looks across the workspace and the
tools connected to it, and comments, views, teams and users are connector-only
as well. So the connector earns its slot on search and on the workspace
furniture, not on content access, and the CLI is worth having beside it
([issue #94](https://github.com/getmonoceros/workbench/issues/94)).

The same shape already exists for Atlassian: `twg` in the `atlassian` feature
reaches Jira with a token, and the `rovo` connector reaches it with a sign-in.
A workspace that forbids OAuth apps keeps the CLI half.

**Docs servers earn their place by what they know, not by being free.** Context7
is in because a model's knowledge of a moving library is older than the
container. Microsoft Learn is in for .NET and Azure and explicitly nothing else:
asked about Django it answers with the SQL Server driver for Django, so its
description and briefing say where its ground ends. A docs server that only
repeats what Context7 has does not qualify.

**Write access is not a separate risk class.** Rovo, Notion, Linear and Figma
can all write, with the rights of the account that signed in. So can `gh` and
`psql`. The account grants what it grants; the connector is not the place to
re-litigate it. Each briefing does say to write only where the task calls for
it.

**Where a provider offers both OAuth and a token, the connector takes OAuth
only.** Rovo is the case: the token route already exists in this workbench as
the `atlassian` feature, where `twg` and `forge` use an API token from the
container's shell. A workbench that cannot use OAuth apps takes the CLI instead.
One route per path keeps the descriptor honest about what it needs.

**A host-local server is not a candidate.** Figma's desktop server listens on
the host's `127.0.0.1:3845`, which a container has no route to, deliberately.
The hosted endpoint is used instead. The same reasoning keeps Obsidian out: its
vault is a host filesystem path, and reaching it would mean a mount outside the
workspace.

**A language server bridge was considered and rejected.** OpenCode already ships
LSP as a feature option, so it would only serve Claude Code and Rovo Dev, and it
costs one process per language server. A container always carries Python and
Bash on top of what the yml declares, so a Java workbench would run four
of them beside the agent.

**Verification is per connector, against a real container.** The endpoint
answers `tools/list`, `monoceros check` names the tools or reports a pending
sign-in, and the agent can call one. A connector that was only read about in a
README is not verified.

## Not decided here

Whether a connector implied by a language or a feature should be added
automatically instead of by name is
[issue #93](https://github.com/getmonoceros/workbench/issues/93). Two candidates
exist for it and both are credential-free: `forge` next to the `atlassian`
feature's `forge` option, and `microsoft-learn` next to the `dotnet` language.
