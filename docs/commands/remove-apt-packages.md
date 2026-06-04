# `monoceros remove-apt-packages`

Inverse of [`add-apt-packages`](./add-apt-packages.md). Removes one or
more apt packages from the container config.

## Synopsis

```sh
monoceros remove-apt-packages <containername> [--yes] -- <pkg> [<pkg> …]
```

As with `add-apt-packages`, the package list is passed **after `--`** so
that names with a `-` prefix are not parsed as flags by citty.

## Mechanics

Entries in `aptPackages:` are removed from the yml. Surrounding comments
on **retained** packages stay unchanged. If the list ends up empty, the
field is dropped entirely.

## Idempotency

Packages that aren't in the list are ignored. If all listed packages are
already absent → no-change.

## Example

```sh
monoceros remove-apt-packages sandbox --yes -- make jq
monoceros apply sandbox
```

## Related commands

- `monoceros add-apt-packages` — inverse
- `monoceros apply <name>` — materialization
