# ADR 0061: Machine-wide settings live in the global env, and the global yml is gone

- Status: accepted
- Date: 2026-09-28
- Implements: #61
- Completes: [ADR 0035 §5](0035-atlassian-env-auth-and-provider-token-strategies.md)
  (retire `monoceros-config.yml`, deferred there)
- Amends: [ADR 0007](0007-port-management-traefik.md) (where the proxy host
  port is set), [ADR 0018](0018-tool-freshness-model.md) (where the staleness
  threshold is set), [ADR 0044](0044-the-git-identity-comes-from-declared-sources-only.md)
  (drops identity source 4)

## Context

The machine had two global config files. `monoceros-config.env` held the
shared secrets and, since ADR 0044, the git identity. `monoceros-config.yml`
held four things: `routing.hostPort`, `upgrade.staleDays`, a
`defaults.git.user` identity and `defaults.features`, per-feature option
defaults. Nothing wrote the yml any more, but four commands still read it, the
installers seeded it, and every `init` told builders to put shared
credentials into it.

Two files for one concern meant two places to look, and the yml was the only
place outside an env file where Monoceros asked for personal data.

## Decision

**`monoceros-config.env` is the one machine-wide config file.**

- `routing.hostPort` becomes `MONOCEROS_HOST_PORT`, `upgrade.staleDays`
  becomes `MONOCEROS_UPGRADE_STALE_DAYS`. Both are read from the global env
  only, never from a workbench's `<name>.env`: there is one proxy and one
  nudge per machine. A value that is set but not a number in range is an
  error that names the key and the file, because falling back to the default
  would put the proxy on a port the builder did not choose.
- `defaults.git.user` goes without a replacement. `GIT_USER_NAME` and
  `GIT_USER_EMAIL` in the global env were already a source of their own, one
  step higher in the cascade.
- `defaults.features` goes too. Its purpose, a credential entered once instead
  of in every workbench, is what a `${VAR}` in the workbench yml resolved from
  the global env already does. What it could do beyond that, a global default
  for a non-credential option, had no known user.

**An existing yml is migrated once, by the CLI.** The code that reads the
machine-wide settings runs the migration first. So every command that needs
one of them does it: `apply`, `start`, `status`, `port`, `add-port` and
`remove-port`. The other `add-*` commands read no machine-wide setting and
leave the yml alone until the next `apply`.

- A key whose value differs from its default moves into the global env.
- A `defaults.features` credential (`surface: env`) moves under the variable
  name the workbench yml already references, so it keeps working without an
  edit.
- A key the env already sets is not overwritten. The env wins, and the message
  says so.
- Any other `defaults.features` option cannot live in an env, because nothing
  reads it from there. The message lists it for the builder to carry into the
  workbench yml.
- The file is then renamed to `monoceros-config.yml.migrated`. Every later run
  finds no yml and does nothing.
- Values are never printed. A moved key may be a token.

The CLI and not the installer does it, because the CLI has the yml parser, the
catalog that says which option is a credential, and runs where the settings are
read. The installers stop seeding the yml and, while a `.migrated` file exists,
say that it can be deleted.

**The home marker moves with it.** `monoceros-config.sample.yml` was also what
tells the CLI where its bundle is and that `.local` is the dev home. Both
markers are now `monoceros-config.sample.env`, which ships in the same places.

## Consequences

- Behaviour changes for existing users, once and with a message.
- No yml, global or per workbench, holds personal data any more.
- A future machine-wide scalar gets a variable in the global env and a getter
  next to the two in `config/global.ts`.
- ADR 0044's cascade is now: yml override, env, host `git config --global`,
  prompt.
