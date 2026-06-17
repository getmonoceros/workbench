# ADR 0023: Feature-contributed workspace runtime env

- Status: accepted
- Date: 2026-06-17

## Context

ADR 0021 gave **services** a way to inject named runtime env into the
workspace container: a `service.connectionEnv` map of templates that
`serviceConnectionEnv()` renders and writes into the workspace's compose
`environment:` block. Those vars are real process env, visible to every
process in the container (interactive shells, the post-create dispatcher,
and non-interactive agent subshells alike).

**Features** had no equivalent. A feature's options reach its `install.sh`
only at **build time** (as env vars the devcontainer build passes in); they
do not land in the running container's shell. Tools that authenticate from a
persisted credential file work around this with a post-create login hook
(the atlassian feature does this for `acli rovodev` and `twg`). But some
tools authenticate purely from **runtime environment variables**, with no
login step and no credential file:

- **Atlassian Forge** (`@forge/cli`). `forge login` stores credentials in
  the OS keychain, which on Linux means libsecret plus a running, unlocked
  keyring daemon over D-Bus. Atlassian's documented path for containers and
  WSL is explicitly the opposite: **do not** run `forge login`, set
  `FORGE_EMAIL` / `FORGE_API_TOKEN` instead, which the CLI reads at command
  time.

For Forge we need those two vars present in the container's process
environment, sourced from credentials the atlassian feature already
collects (`email` / `apiToken`). A login hook is the wrong tool: there is
nothing to log in to, only env to expose.

## Decision

Give features the **runtime-env sibling of `connectionEnv`**:
`feature.workspaceEnv` in the component descriptor.

```yaml
feature:
  version: 1.2.0
  workspaceEnv:
    - whenOption: forge
      vars:
        FORGE_EMAIL: '${email}'
        FORGE_API_TOKEN: '${apiToken}'
```

- Each block's `vars` maps an env-var name to a template; `${optionName}`
  tokens are filled at scaffold time from the feature's already-resolved
  option values (the same values `.env` interpolation produced at apply).
- An optional `whenOption` gates the block: it is emitted only when that
  option resolves truthy. So a container that turns the tool off (e.g. the
  `atlassian/twg` preset, which sets `forge: false`) gets none of its vars,
  while the bare `atlassian` selector - all toggles on - gets them.
- A var that renders empty is dropped, so an unfilled secret yields no var
  rather than an empty one that would mask the tool's "not configured" path.
  This matches the atlassian login hooks, which install only when their
  credentials are present.

`featureWorkspaceEnv()` renders these and the scaffold injects them at the
**same two points** as service connection env:

- **compose mode** - merged into the workspace service's `environment:`
  block, next to `serviceConnectionEnv()`.
- **image mode** - emitted as a `containerEnv` object on the
  devcontainer.json (services, hence service connection env, only exist in
  compose mode).

`workspaceEnv` is **catalog/CLI-side only**, like `presets`. It drives how
the workbench wires the container, not the feature install, so it is **not**
emitted into the published `devcontainer-feature.json`. The descriptor
loader validates that every `whenOption` and every `${token}` references a
declared option, so a typo fails at load time instead of silently rendering
empty.

## Consequences

- Forge joins the atlassian feature as a third toggle (`forge`), installed
  globally via npm, authenticated through the shared account with no login
  hook, no keychain, and no persistent home path - it is stateless at rest.
- Any future feature that authenticates from runtime env (rather than a
  credential file) reuses this mechanism instead of inventing a per-feature
  workaround.
- The injection paths and the "real process env, visible to every process"
  guarantee are shared with ADR 0021; the two are deliberately the same
  channel under two descriptor blocks (service `connectionEnv`, feature
  `workspaceEnv`).
