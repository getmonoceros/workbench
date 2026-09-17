# ADR 0057: A workbench template is a prepared yml, not a bundle of flags

- Status: accepted
- Date: 2026-09-17
- Relates to: [`docs/concept.md`](../concept.md) ("fixed stack templates" in
  the list of what Monoceros is not),
  [ADR 0019](0019-component-taxonomy-service-feature-dependency.md) (what
  becomes a component),
  [ADR 0020](0020-unified-component-descriptors.md) (the descriptor the
  `surface:` marker lives in),
  [ADR 0043](0043-opencode-roles-as-its-own-component.md) (a way of working
  ships as a component you choose)

## Context

Two things go wrong in the same minute, the first time someone runs `init`.

**A working setup cannot be said on the command line.** The `--with-*` flags
take a list of component names, and a name is all they take. A feature's
plugins are a nested block with a marketplace url and an enable list, and the
options marked `surface: yml` (the permission mode, the `twg`/`rovodev`/`forge`
switches) sit next to the ref in the file. Neither has a flag, and neither can
get one without turning the command line into a config format. So a setup that
needs them has lived in a docs page that the builder retypes, and a newcomer
has to be told it exists at all.

The discovery chain is exactly such a setup: `claude` carrying the
`discovery-atlassian` plugin, `claude-code-roles`, and `atlassian` with `twg`
on while the other two CLIs stay off. Three components, of which two carry
something no flag can express.

**Nothing asks for the values the container needs to run.** A feature marks its
credentials `surface: env`, init seeds them as blank keys, and that is the whole
interaction. The builder finds out the keys exist from the documentation, or
from a command inside the container failing on its first call.

Templates existed early on and were dropped in favour of `init` plus the
`--with-*` flags, and the concept document still lists **fixed stack
templates** (`vite-react-pg`, …) among the things Monoceros is not. That
sentence is about a template that decides the product's stack. This one decides
none: it carries the tooling for a way of working, and the stack arrives
afterwards from the technical brief through `add-*`. The boundary is touched
and holds.

## Decision

**A template is a complete, prepared workbench yml**, under
`packages/cli/templates/workbenches/<name>.yml`, and `monoceros init <name>
--template=<template>` starts from it. Exactly two placeholders are substituted,
the container name and the runtime version. Nothing is composed, rendered or
merged, which is what lets the file carry the plugin block and the yml-surfaced
options: it is the output, not an input to a generator.

Keeping it a real yml is the point, and not only for the shipped ones.
**Templates are searched in `<MONOCEROS_HOME>/templates/workbenches/` first,
then in the set that ships with the CLI**, so a builder's own file under a
shipped name replaces it. Because a template is just a workbench yml, making
one is copying a config that works and putting the two placeholders back in.
There is no format to learn, no generator to run, and nothing for us to
maintain on their behalf. That also keeps the shipped set honest: it is a
starting point, not the list of setups Monoceros allows.

**The `--with-*` flags apply on top, through the `runAdd*` functions the
`monoceros add-*` commands use.** Not a second merge implementation: the same
one. A component the template already carries therefore behaves exactly as it
does when you add it by hand afterwards, down to the error when a feature is
present with different options. Nothing had to be decided about the
combination, because nothing about it is new.

A rejected `--with-*` entry rolls the config back. Otherwise the builder fixes
their command line and meets "Config already exists" for a file they never got
to keep.

**The first template is `discovery-atlassian`**, the entry point for the
discovery chain and for whoever joins that project later. It is named after the
plugin it carries, not after the journey it enables: the next backend gets
`discovery-notion`, and a name like `from-idea-to-code` would have had nothing
left to call it.

**It names models for the three roles**, which
[ADR 0043](0043-opencode-roles-as-its-own-component.md) rules out for the
feature itself: a model id ages faster than a release, and a stale default in a
shipped feature is worse than none. A template is the other case. Its values
land once, in a file the builder owns from that moment, next to a comment
saying they are a starting point and how to empty them. The feature's own
defaults stay blank, so nobody who adds `claude-code-roles` by hand inherits an
opinion. The template says out loud what the roles were designed around:
planning and reviewing carry the thinking and get the stronger model,
implementing follows a plan that already names the files and runs cheaper.

**Init asks for the `${VAR}` values the finished yml references**, reading them
off the written file rather than off any in-memory composition. That is what
makes one code path cover a template, the flags, and the two combined: by then
they are all just entries in the same file. Reading the option _values_ also
keeps the questions honest, because a curated template may leave an option out
and asking for a variable the yml never mentions would be asking for nothing.

**The same prompt runs on `add-feature` and `add-mcp-server`.** A feature added
three commands later needs its token no less than one that arrived with the
first config, and both already seeded the blank keys, so the only thing missing
was the question. Each asks only about the keys it just seeded, which keeps a
second `add-feature` of the same component silent and never re-asks for a value
the builder has typed.

Empty stays a valid answer throughout. A subscription login needs no API key,
and every value can be filled in later in the env file, which is exactly what
init wrote before the prompt existed. `--yes` skips it, and so does a
stdin or stdout that is not a terminal, which covers CI and the e2e suite
without a flag of their own.

## Consequences

- **The template is a new place a component can be named.** A component or an
  option renamed or retired has to be fixed here too, because a frozen copy of
  a yml cannot follow the catalog. Two tests stand in for that: one renders the
  shipped template and asserts its refs, and one checks every option name in it
  against the live descriptors, so a rename fails here rather than in somebody's
  first apply.
- **The prose in a template is a copy and will drift.** The first draft was a
  generated yml frozen as-is, which meant it carried the catalog's own feature
  descriptions and would have gone stale the first time one was reworded. The
  comments are now about why a component is in _this_ template, which is
  something only the template knows, with the catalog text one link away.
- **The Windows completion needed a third kind of value source.** Until now a
  value was either baked into the generated script or resolved host-side by
  kind. Templates are both at once, so a source can now carry its known values
  _and_ a kind, and the script merges the two. Without that, Windows would
  offer either the shipped templates or the builder's, never both.
- **A dynamic kind with no branch in the pwsh script fails on Windows only**,
  silently, while bash and zsh keep working. A test now walks every kind the
  model emits and asserts the script has a branch for it, so the rule in
  CLAUDE.md is checked rather than remembered.
- **A template does not update.** It seeds a file that is the builder's from
  then on, the same way `init` always has. A later, better `discovery-atlassian`
  reaches an existing workbench through `add-*`, not by rewriting a config
  somebody has edited.
- **The prompt is the first time init asks anything.** It stays a prompt and
  never a gate: nothing about it can fail a scripted run, and the answer set
  that leaves everything empty produces exactly the file that was produced
  before.
- **`monoceros init --template=x --with-features=y` can fail after writing.**
  The rollback makes that invisible in the common case, but a builder watching
  the filesystem sees the config appear and disappear.
