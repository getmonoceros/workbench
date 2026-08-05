# ADR 0045: MCP servers are catalog components, and the yml names them in one line

- Status: accepted
- Date: 2026-08-04
- Relates to: [ADR 0019](0019-component-taxonomy-service-feature-dependency.md)
  (what becomes a component at all),
  [ADR 0020](0020-unified-component-descriptors.md) (the descriptor a component
  is built from), [ADR 0021](0021-per-instance-service-connection-env.md) (one canonical
  definition translated per consumer),
  [ADR 0018](0018-tool-freshness-model.md) (why agent config is written at apply
  instead of baked into a cached layer)

## Context

A workbench could be full of tooling and the agent inside it still could not
reach a browser, current library documentation, or the issue tracker, because
nothing in the yml described what the agent _knows_. Every MCP server had to be
registered by hand inside the container. No component descriptor mentioned MCP,
and no feature installation wrote an MCP config.

The obvious first move, putting each server's config into the container yml, was
the wrong one. An MCP definition is four to eight lines of command, args,
transport and env that a builder has no business knowing, and it breaks the rule
the yml has held so far: nothing in it is hand-authored when the catalog could
know it.

But the catalog will only ever curate a handful of servers, and there are
thousands. So the long tail needs a way in that is not "hand-register it inside
the container and lose it on the next machine".

## Decision

**MCP servers are catalog components** (`category: mcp-server`), and the yml gets its
own top-level `mcpServers:` key that names them.

`mcpServers:` rather than folding connectors into `features:` because it answers a
different question for the builder. `features:` is what is installed; `mcpServers:` is
what the agent can reach. The plumbing differs too: a connector installs
nothing, needs no GHCR feature and no OCI resolution, only a config file written
at apply.

### Three ways in

The repo already answers "what about everything the catalog does not carry?"
twice for features: `add-feature` takes any OCI ref, and `add-from-url` takes any
install script behind a loud warning. MCP follows the same shape, or MCP would be
held to a stricter rule than features with no way to justify it.

1. **A catalog connector, one line.** `monoceros add-mcp-server <name> context7`.
   The definition lives in the descriptor; secrets go through `surface: env`.
2. **Any server, as its own definition in the entry.** The provider's published
   config, transposed into the entry: `transport`, `command`/`url`, `env`/
   `headers`. Longer, but declarative, so it travels to another machine.
3. **An overlay component**, when the same server is reused across workbenches
   or inside a team. That is [#8](https://github.com/getmonoceros/workbench/issues/8),
   and it turns tier 2 back into one line. #8 is therefore a real prerequisite
   for the own-server story, not a nice-to-have.

Beside all three, `claude mcp add` inside the container keeps working and
survives apply, because `~/.claude.json` is a persistent-home file. It is not
one of the tiers: it appears in no yml and reaches no other machine.

### Naming follows the keys that were already there

Every other yml key is a plural noun for what its entries are: `languages`,
`services`, `features`, `repos`. So the key is `mcpServers:`, not `mcp:`, and the
flag is `--with-mcp-servers` the same way `aptPackages` maps to
`--with-apt-packages`. The commands name a single object like their siblings do
(`add-service`, `add-feature`), hence `add-mcp-server` / `remove-mcp-server`.

`mcpServers` is also, by coincidence worth taking, the exact key every provider
uses in the snippet it publishes. A builder pasting one recognises the word.

The descriptor side keeps camelCase like every other descriptor field, so the
block is `mcpServer:` under `category: mcp-server`, and the category directory is
`components/mcp-servers/`.

### One key, and the definition discriminates

Both forms use `name:`. Not `ref:`, which in this same file already means an OCI
ref and would be borrowed wrongly. What tells the two apart is not the name but
whether the entry carries a definition:

- **No definition** (optionally with `options:`) means resolve, against the
  catalog and then the overlay. An unknown name is an error pointing at
  `monoceros list-components`.
- **A definition** means the entry stands for itself and nothing is resolved,
  **even when the name also exists in the catalog**. Otherwise a working yml
  would change meaning the day a curated `notion` connector ships. Apply notes
  the shadowing and carries on.
- **`options:` together with definition fields** is a schema error. An option
  cannot be validated without a descriptor.

### Merge at apply, never write

One canonical definition per server, translated into the format of each agent
present in the container, the same shape [ADR 0021](0021-per-instance-service-connection-env.md)
uses for service connection env: Claude Code's `~/.claude.json`, OpenCode's
`~/.config/opencode/opencode.json`, and Rovo Dev's `~/.rovodev/mcp.json`.

**Every agent in the container gets every server.** The briefing is one file that
all of them read, so it tells all of them the servers are there. Registering for
only some would make the briefing lie to the rest, which is how the first real
test failed: OpenCode read in AGENTS.md that `context7` was available and could
not find it, because only Claude Code had been wired.

The formats differ more than they look. OpenCode says `local`/`remote` rather
than naming the transport (so `http` and `sse` both land on `remote`), puts the
executable and its args in one `command` array, and calls the env `environment`.
Rovo Dev names the transport like we do but under `transport`, and offers an
`enable_instructions` flag that feeds the server's own prose into the agent's
prompt, which Monoceros never sets on a builder's behalf. Three clients, three
shapes: exactly why the descriptor holds one canonical definition and the
translation lives per agent.

Agent presence is not the same question as feature presence. Rovo Dev ships
inside the atlassian feature alongside twg and Forge, each behind its own
toggle, so a target may declare an extra condition on the feature's options.

That file **survives apply** and **Claude writes to it itself** (project trust,
history, servers the builder added by hand). So:

- only the `mcpServers` key is touched, everything else is left alone
- the merge is idempotent, because it runs again on every apply
- Monoceros records which entries it owns, or a connector removed from the yml
  could not disappear without taking a hand-added one with it

The ownership record lives host-side in `.monoceros/mcp-registrations.json`, not
as an extra key inside `.claude.json`: that file belongs to another tool, and a
foreign key in it is exactly the kind of detail that breaks on the next Claude
Code update. It is also not in `state.json`, which answers a different question
(which yml this container came from) and is written by apply _after_ the
scaffold, whereas the record has to be read and written in the same step as the
merge.

### Two things stop the apply

**A name in both places.** If a server was registered by hand and a connector of
the same name is in the yml, apply halts and says the duplicate has to go, from
one side or the other. No precedence rule: neither answer is defensible. Letting
the yml win eats a change the builder made deliberately; letting the hand-written
one win makes the yml a lie.

**A credential that resolves empty.** A connector whose `${VAR}` never got filled
would be registered with a blank `Authorization` header: present in the agent's
tool list, failing on first use, in the middle of a run. That is the failure mode
[#82](https://github.com/getmonoceros/workbench/issues/82) exists to kill, so it
is an error that names the option and the file to fill it in. `add-mcp-server`
and `init --with-mcp-servers` seed the key into `<name>.env` for exactly this reason: the
error is only fair if the slot is already waiting.

An `mcpServers:` block with no agent in the container is an error too, rather than a
silently ignored key that looks like a working container.

## Consequences

- A new category runs the length of the CLI: descriptor, both catalog loaders,
  the container schema, `init --with-mcp-servers`, `add-mcp-server` / `remove-mcp-server`,
  `list-components`, completion, the apply merge, the agent briefing.
- The briefing names the reachable servers, so an agent does not rediscover per
  session what it already has.
- `catalog.json` gains an `mcpServers` array. Additive, so the schema version stays.
- A remote (`http`/`sse`) connector leaves the container boundary; a `stdio` one
  does not. The generated yml says which, per entry, because the isolation
  promise reads differently for the two and it should not need looking up.
- `monoceros check` verifies the chain and names the tools each server serves.
  It was pulled forward from the deferred list by the first real run, where an
  agent claimed it had no `context7` tool, reported results from tools it had
  invented (`list_mcp_resources`, which OpenCode does not have), and cost an hour
  of debugging the wrong link. The registration had been correct the whole time,
  and a different model used `context7_resolve-library-id` on the first try. A
  model's account of its own tool list is not evidence, so the check reads the
  agent's config file and asks the server itself.
- Deferred, in the issue and not here: a `--from-json` that takes a provider's
  published snippet verbatim, and a per-role filter.
