# ADR 0034: Shell history persists across `apply`

- Status: accepted
- Date: 2026-07-20

## Context

`monoceros shell` lands the builder in an interactive bash inside the
workspace container. Bash keeps its command history in
`~/.bash_history` (`/home/node/.bash_history`) and writes it on shell
exit, so within one container instance the history is there and the up
arrow works across repeated `shell` sessions.

But `/home/node` lives in the container's writable layer, not in a
bind or volume. `apply` force-removes and recreates the workspace
container (see `devcontainer/compose.ts`), so the history file dies on
every rebuild. To a builder who applies often that reads as "there is
no history at all" - the one piece of state a shell is expected to
carry does not survive.

The workbench already has a mechanism for exactly this: the
per-feature persistent-home binds from ADR 0020. A feature declares
`persistentHomePaths` / `persistentHomeFiles`, and the scaffold binds
`<container-dir>/home/<sub>` onto `/home/node/<sub>`; the host source
sits under the container directory, which `apply` never touches. That
is how `.claude`, `.config/gh`, and friends already survive rebuilds.

Shell history is not a feature, though. Every container has a shell,
with or without any AI tool. Hanging history off a specific feature
would make it appear and disappear depending on the yml, which is the
wrong model for base shell state.

## Decision

Persist `~/.bash_history` for **every** container, always-on, through
the same bind mechanism as the per-feature persistent-home entries.

A base list (`BASE_PERSISTENT_HOME_FILES` in
`packages/cli/src/create/scaffold.ts`) carries `.bash_history` and is
merged with the resolved features' declarations at the three sites that
consume persistent-home paths: the image-mode `mounts`, the
compose-mode `volumes:`, and the host-side pre-create in
`writeScaffold`. The file is seeded empty and, like every other
persistent-home entry, is never truncated on re-apply once it exists.

No custom `HISTFILE`, `histappend`, or `PROMPT_COMMAND` wiring. Bash's
default is to overwrite `~/.bash_history` wholesale on exit; with
parallel shells the last one to exit wins. That matches how a normal
host shell behaves and is the right trade-off for a single-builder
workbench - robustness beyond that would be scope the workbench does
not need.

## Consequences

- History survives `apply` for every container, with no yml opt-in.
- One more always-present bind (`home/.bash_history`) in the generated
  devcontainer.json / compose.yaml. `home/` is already gitignored at
  the container root, so the history file is never committed.
- Future base shell state (other dotfiles) has an obvious home: add it
  to `BASE_PERSISTENT_HOME_FILES`. The per-feature path stays for
  tool-specific config that should track the feature.
