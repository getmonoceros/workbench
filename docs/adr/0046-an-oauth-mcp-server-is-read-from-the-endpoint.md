# ADR 0046: an MCP server that signs in is read from the endpoint, not from the agent

- Status: accepted
- Date: 2026-08-05
- Relates to: [ADR 0045](0045-mcp-servers-as-catalog-components.md) (MCP servers
  as catalog components, and the check that verifies the chain)

## Context

A growing share of MCP servers authenticate with OAuth. There is no credential
to declare: the builder signs in once inside the container, in a browser, and
the agent stores the grant. Linear's server and Atlassian's Rovo MCP both work
this way, and the second one matters, because a site with API tokens disabled
leaves OAuth as the only way in.

The registration side already worked. An inline entry with a `url:` and no
credential applies unchanged into all three agents, and Claude Code and OpenCode
complete the flow through the existing browser bridge. What did not work was
everything the workbench says _about_ such a server.

`monoceros check` probes each remote server for its tool list. It holds no
credential, so an OAuth server answers `401`, and the check reported a healthy
server as one that "did not answer". A curated OAuth connector had no way to say
in its descriptor that a credential is optional, and the yml it generated would
show an entry with no key and no explanation for the gap.

The tempting fix for the check was to ask each agent whether it has signed in.
That means knowing where Claude Code, OpenCode and Rovo Dev each keep their MCP
grants, in three private formats that nothing obliges them to keep stable, and a
fourth on the day a new agent joins the catalog. It also answers a question the
check has no business asking: whether a person has done something, rather than
whether the workbench is correctly built.

## Decision

**The check reports what the endpoint demands, not what an agent holds.**

A refused probe reads as a pending sign-in when all three hold:

- the status is `401` or `403`,
- the response carries `WWW-Authenticate`, so the server is naming a way in
  rather than just refusing,
- and the registration sent no credential of its own.

The third condition is what keeps the tolerance honest. A server we do send a
token to and that still refuses us has a bad token, which is exactly the finding
a builder needs; only a registration with nothing to send can be waiting for a
sign-in. A `401` without `WWW-Authenticate` stays a failure for the same reason.

The report is therefore worded to be true in both states, because the probe
cannot distinguish them: `signs in interactively; authenticate once inside the
container`. Not "waiting for a sign-in", which would be a false alarm in a
container whose agents signed in weeks ago.

**A descriptor says it with `auth: oauth`** on its `mcpServer:` block. Two things
follow. The generated yml header tells the builder where the sign-in happens,
instead of leaving a credential-less entry unexplained. And a `${option}` that
resolves empty drops its header or env key instead of failing the apply, which
is the one deviation from ADR 0045's rule that an empty credential is a hard
error. The rule stands where a credential is the only way in; on an OAuth
connector the sign-in is the other way in, and that is what lets one connector
offer both, as Linear does.

## Consequences

- Adding a fourth agent costs nothing here. The check reads HTTP status and one
  header, and knows nothing about where any agent stores a grant.
- The check cannot tell a builder that they have not signed in yet. That is the
  accepted price, and the wording carries it.
- Rovo Dev cannot complete these flows today: the client bundled with `acli`
  sends its credentials in the header and the body at once, and a token endpoint
  that follows RFC 6749 rejects that (verified with acli 1.3.22 against Linear).
  Nothing stored, so the sign-in page reopens on every start and acli then
  disables the server. It is an upstream bug, documented rather than worked
  around. Where a provider offers a token as an alternative, the token is the
  better route: it works in all three agents and needs none of this.
- `catalog.json` carries `auth` on an mcp entry, additively, so the published
  catalog says how a connector authenticates without a schema bump.
- No OAuth connector ships with this change. Linear and Atlassian's Rovo MCP are
  the next two, and the point of doing the mechanism first is that each of them
  is then a `component.yml` and nothing else: no resolver change, no check
  change, no projection change.
