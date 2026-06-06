# `monoceros upgrade`

Change a container's pinned **runtime image version** and re-apply.

```sh
monoceros upgrade <name>            # pin to the latest published version
monoceros upgrade <name> <version>  # pin to an exact version, e.g. 1.1.0
monoceros upgrade --list            # list available versions, change nothing
```

## Why this exists

The runtime image version is pinned per container in its yml
(`runtimeVersion:`) and is **never bumped by a routine `monoceros
apply`** — see [ADR 0017](../adr/0017-per-container-image-pinning.md).
That keeps existing containers reproducible: re-applying to add a repo
or tweak a port can't silently swap the toolchain underneath your work.
`upgrade` is the one deliberate, opt-in path that moves the pin.

## What it does

1. Resolves the target version:
   - an explicit `<version>` is used as-is (no network lookup), or
   - with no version, the **latest** published runtime version is
     resolved from the registry.
2. Rewrites `runtimeVersion:` in
   `$MONOCEROS_HOME/container-configs/<name>.yml`, leaving everything
   else (including comments) untouched.
3. Runs `monoceros apply <name>` to rebuild the container on the new
   image.

Your projects, service data, and workspace are bind-mounted and are not
touched by the rebuild (see [ADR 0003](../adr/0003-container-state-model.md)).

## `--list` and "latest"

The runtime image is public, so listing versions needs **no
credentials** — but the OCI registry still issues a bearer token, which
GHCR hands out anonymously. `--list` and the "latest" resolution make
one network call to fetch the published tags. If you're offline or the
registry is unreachable, pass an explicit `<version>` to skip the
lookup entirely.

## Notes

- Versions are exact `major.minor.patch` (e.g. `1.1.0`) — no ranges or
  placeholders (ADR 0017).
- New containers are pinned automatically by `monoceros init`; `upgrade`
  is for moving an existing container to a newer runtime, or for pinning
  a pre-pinning yml that `apply` rejected.
- You can also just edit `runtimeVersion:` in the yml by hand and run
  `monoceros apply` — `upgrade` is the guided equivalent.
