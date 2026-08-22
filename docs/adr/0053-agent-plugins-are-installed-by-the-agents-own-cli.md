# ADR 0053: Agent plugins are declared in the yml and installed by the agent's own CLI

- Status: accepted
- Date: 2026-08-22
- Relates to: [ADR 0018](0018-tool-freshness-model.md) (tooling floats, it is
  not pinned), [ADR 0020](0020-unified-component-descriptors.md) (the
  descriptor a component is built from),
  [ADR 0031](0031-pat-based-repo-auth.md) (per-host repo tokens),
  [ADR 0006](0006-https-only-repo-auth.md) (HTTPS-only sources, and why the
  provider check belongs to apply rather than the schema)

## Context

A workbench with the `claude-code` feature ships the agent but no plugins.
Whoever wants one types `/plugin marketplace add …` and `/plugin install …` by
hand in every fresh workbench, and again after every `remove`. The yml is
supposed to be the source of truth for what is in the container, and plugins
were not in it.

The obvious implementation is to write the agent's own settings file: Claude
Code reads `extraKnownMarketplaces` and `enabledPlugins` from
`~/.claude/settings.json`, and Monoceros already writes `permissionMode` into
that same file, so the mechanism is there.

A probe showed why that is a trap. A marketplace whose `marketplace.json`
declares `name: keytest-real-name`, registered under the settings key
`keytest-fantasy-key`, landed in `known_marketplaces.json` as
`keytest-real-name`. No error, no warning: the key is not the name, the
manifest's name wins. `enabledPlugins` then needs `plugin@keytest-real-name`,
so a key of our choosing registers the marketplace correctly and leaves every
plugin disabled. The failure looks like success.

Monoceros could learn the real name by fetching the manifest at apply time.
That means a network call and a clone before the container exists, for a name
that the agent's own CLI already resolves.

## Decision

**The yml declares plugins; the agent's CLI installs them.** `plugins:` sits
next to `options:` on the feature entry. After the container is up, apply runs
inside it:

```
claude plugin marketplace add <url or path>
claude plugin install <plugin>
```

`install` resolves a plugin by bare name across the registered marketplaces and
writes `enabledPlugins` itself, so Monoceros never has to know the marketplace
name. Both commands are idempotent (a second `add` reports "already on disk", a
second `install` "already installed", both exit 0) and both work without the
agent being logged in, which is what makes them usable in a build step.

Which CLI to run is a catalog fact, not a hardcoded one: the descriptor's
`feature.pluginCli` names it, and its presence is what makes `plugins:` on that
feature meaningful at all. A `plugins:` block on a feature without it is a
config error, raised before anything is built.

**A marketplace is a full HTTPS git URL, or a path under `projects/`.** No
`owner/repo` shorthand: it silently means GitHub and leaves a builder on GitLab
or Bitbucket no way to say otherwise. This is the rule `repos:` already
follows, down to the regex, the three auto-detected hosts and the `provider:`
field every other host must declare. A private marketplace is cloned by the
agent through the container's git and the same mounted credential helper, so
its host goes through the same credential pre-flight as a repo — otherwise the
missing token surfaces as an opaque clone error inside the agent.

**No `ref:`.** The CLI offers no way to pin a plugin version, and the workbench
already takes that line with its features: tooling floats to what upstream
ships (ADR 0018). A pin the CLI cannot honor would be a lie in the yml.

**`enable` is required.** A marketplace can hold several plugins, and
installing all of them because the builder named none is the wrong default —
our own marketplace would drag in a second plugin nobody asked for.

**The install is best-effort, and the warning names the cause.** A marketplace
that cannot be reached, or a plugin name that is not in it, produces a warning
and leaves the apply green. At that point the container is up, the agent is
installed and the repos are cloned; tearing all of that down over a plugin is
the worse trade.

An exit code is not a cause. The agent CLI's output is captured rather than
streamed, and the warning carries the lines that say what happened (`Failed to
add marketplace: …`, `fatal: unable to get password from user`) with the
spinner labels and git's clone progress stripped out. When the cause is git
having no credentials, the warning also says what to set. The full transcript
stays in the apply log.

It is reported the way every other apply warning is: an end-of-apply block
built with `warnHeading`, printed once through the single writer that frames it
on screen and strips the colours for the log. A warning that picks its own
moment mid-spinner scrolls away, and one that picks its own indentation makes
the builder learn a second vocabulary. That writer now carries all four blocks
(repo access, uncloned repos, feature notes, agent plugins), so the next one
cannot drift either.

A private marketplace should not get that far: its host goes through the repo
credential pre-flight, which names the missing token before anything is built,
including what a missing token costs a plugin.

**No `add-plugin` command.** `init` and `add-feature` write a commented
`plugins:` example onto the feature entry, the same carrier a curated service
uses for its `volumes:` scaffold. The example is a real, complete entry, so
uncommenting it parses and editing it is one word at a time. A separate command
would have to be mirrored into `COMMAND_SPECS` for shell completion, and the
scaffold makes it unnecessary.

## Consequences

- Plugins reach a fresh workbench without anyone typing a slash command, and
  the yml says which ones.
- Apply gained a network-dependent step at the very end. It cannot fail the
  build, but it can be slow on a cold marketplace.
- Plugins are not reproducible across time: two applies a month apart can
  install different versions. That is the same trade the features already
  make, and the same warning applies — a workbench pins its runtime, not its
  tooling.
- `plugins:` is accepted by the schema on every feature entry and rejected at
  apply for a feature that cannot host them. Consistent with ADR 0006: the
  schema checks shape, the catalog check belongs to apply.
- Only `claude` hosts plugins today. A second agent gets one descriptor line,
  no code change.
