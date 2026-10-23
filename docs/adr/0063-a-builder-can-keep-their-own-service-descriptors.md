# ADR 0063: A builder can keep their own service descriptors

- Status: accepted, amended 2026-10-23 (see [Amendment](#amendment-2026-10-23-mcp-servers-too))
- Date: 2026-10-21
- Relates to: [ADR 0020](0020-unified-component-descriptors.md) (the
  descriptor format),
  [ADR 0021](0021-per-instance-service-connection-env.md) (connection env
  travels with the instance),
  [ADR 0057](0057-a-workbench-template-is-a-prepared-yml.md) (the same
  precedence for templates)

## Context

A service the catalog does not ship, Kafka from `confluentinc/cp-kafka` say,
goes in as a custom image: `name` and `image`, plus a commented scaffold the
builder fills in. Someone who uses it in every workbench fills it in every
time, `connectionEnv` included, and a team has no way to share the result
short of forking the workbench.

## Decision

**Service descriptors are also read from
`<MONOCEROS_HOME>/templates/services/<id>.yml`.** One flat file per service,
next to `templates/workbenches/<name>.yml`, so everything a builder keeps for
reuse lives under one directory and the home gets no new top-level entry. The
id is the file name. The content is the shipped descriptor format, so writing
one starts from copying `components/services/postgres/component.yml`.
Validation is the shipped one too.

**Services only.** A service is catalog data alone. A language or feature also
needs an install script published as an OCI feature, which is a different
problem and stays in its own issue.

**The home wins by id**, the precedence templates have. A builder's `postgres`
replaces the shipped one. A builder's service under the id or selector name of
a shipped language, feature or MCP server (`claude` is the `claude-code`
feature) is an error naming the file, because the one
name would then mean a service in one command and something else in the next.

**A broken file is reported by the commands that work with services, not at
import.** The eager service catalog is built when the CLI module loads, before
any command can catch an error. If a builder's file threw there, `--help` and
every Tab press would crash with a stack trace. So the import falls back to
the shipped tree, and `init`, `add-service`, `apply` and `list-components`
load the catalog again and fail with the path.

**Explicit roots stay shipped-only.** The scripts that generate the published
`catalog.json` and the feature manifests pass the checkout's `components/`
and never see the machine's own descriptors. A builder's own service is
local by definition, and `list-components` marks it `(local)`.

## Consequences

- **The yml does not depend on the descriptor.** `add-service` bakes image,
  port, env, healthcheck and `connectionEnv` into the workbench yml, so `apply`
  works on a machine that lacks the file. What it loses there is what is read
  from the catalog by name at apply: briefing lines, client packages, `tools`
  and deferred start. That is the same as for a service renamed with `--as`.
- **`upgrade` follows the builder's image.** It pulls curated images up to
  the catalog's tag by repository, and the builder's descriptor is part of
  the catalog. A builder who pins `postgres:17` in their own `postgres` gets
  `postgres:17` back on `upgrade`, which is what replacing the descriptor
  means.
- **A builder's service carries no `tools`.** A tool is a file next to the
  descriptor, and a flat yml has nowhere to keep one. A new service that lists
  `tools` is an error naming the file; one that replaces a shipped service
  keeps the shipped tools.
- **A builder's service links no documentation page.** The header above its
  block in the yml and the amd64 warning leave the getmonoceros.build link
  out, because the page does not exist.
- **Shell completion reads the home at Tab time.** On Windows the service
  names are a hybrid source like the templates: shipped names baked in, the
  `*.yml` names under `templates/services/` read by the script.

## Amendment (2026-10-23): MCP servers too

A team that uses an MCP server the catalog does not ship wrote the same inline
`mcpServers:` entry into every workbench, transport, url, headers and token
variable included (#134).

**MCP server descriptors are also read from
`<MONOCEROS_HOME>/templates/mcp-servers/<id>.yml`**, by the same rules as
services: one flat file per server, the id is the file name, the content is the
shipped format (`components/mcp-servers/context7/component.yml` is a start),
the home wins by id, and a clash with a shipped component of another category
is an error naming the file. An MCP descriptor is catalog data alone, like a
service, so "Services only" above now reads "services and MCP servers".

**It is written into the yml by name, not inline.** A catalog connector already
is: `add-mcp-server` and `init --with-mcp-servers` write the name and its
options, and `apply` resolves transport, url, headers and the `briefing` lines
from the descriptor every time. An own server goes the same way, so its
briefing always reaches the agent. That differs from a service, whose block is
baked into the yml. The consequence is the opposite one: on a machine without
the file, the workbench does not apply, and the error names the unknown
server. Getting the file onto every machine is what the team template
repository (#133) is for.

**The rest follows services.** The yml header above the entry links no
documentation page, `list-components` marks the server `(local)`, and on
Windows the MCP names are a hybrid completion source that reads
`templates/mcp-servers/*.yml` at Tab time.
