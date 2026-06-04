# `monoceros remove-feature`

Inverse of [`add-feature`](./add-feature.md). Removes a devcontainer
feature entry from the container config.

## Synopsis

```sh
monoceros remove-feature <containername> <feature> [--yes]
```

`<feature>` is — as with [`add-feature`](./add-feature.md) — either a
**catalog short name** (`atlassian`, `atlassian/twg`, `claude`,
`github` — see `monoceros list-components`) or a **full OCI ref** (e.g.
`ghcr.io/devcontainers/features/docker-in-docker:2`). The short name is
resolved to the OCI ref via the same resolver as `add-feature`, so that
`monoceros remove-feature sandbox atlassian` finds the entry that was
set with `add-feature sandbox atlassian`.

## Mechanics

The matching array entry in `features:` is removed from the yml —
including the per-feature documentation comment block that
`add-feature` / `init` placed above it. If the list becomes empty,
`features:` is dropped entirely.

## Idempotency

Feature not in the config → no change.

## Changing options

`remove-feature` plus `add-feature` is the intended way to change the
options of an existing feature. `add-feature` explicitly refuses to
silently overwrite an existing ref with different options.

```sh
monoceros remove-feature sandbox ghcr.io/devcontainers/features/docker-in-docker:2 --yes
monoceros add-feature sandbox ghcr.io/devcontainers/features/docker-in-docker:2 --yes -- version=20.10
monoceros apply sandbox
```

## Related commands

- `monoceros add-feature` — inverse / change options
- `monoceros apply <name>` — materialization
