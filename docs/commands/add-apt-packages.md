# `monoceros add-apt-packages`

Installs arbitrary Debian/Ubuntu apt packages in the devcontainer.

## Purpose

A quick, declarative way to add small tools that are missing from the
base image (`make`, `jq`, `openssh-client`, `vim`, `tmux`, `tree`, `rsync`, …).
Without this command the builder would have to either edit
`devcontainer.json` by hand or run `apt install …` in the container
manually — the latter is not persistent and is lost on the next
`monoceros apply`.

What this is _not_:

- Not a replacement for `add-language` (language toolchains have their
  own devcontainer features with additional setup)
- Not a replacement for `add-feature` (tools that ship their own
  devcontainer feature — e.g. `gh`, `kubectl`, `terraform` — belong
  there, because their feature does more than `apt install`)

## Synopsis

```sh
monoceros add-apt-packages <containername> [--yes] -- <pkg> [<pkg> …]
```

The `--` separates Monoceros flags from the package list. It is
mandatory, because otherwise packages like `--ignore-me` would be
interpreted as flags — a convention consistent with
`monoceros run -- <cmd>`.

## Options

| Flag           | Meaning                                       |
| -------------- | --------------------------------------------- |
| `--yes` / `-y` | Skip the confirmation prompt (for scripts/CI) |

## Mechanics

`add-apt-packages` writes into the container yml at
`$MONOCEROS_HOME/container-configs/<containername>.yml`:

```yaml
aptPackages:
  - make
  - jq
```

Comments and the order of existing entries are left untouched
(AST mutation, no re-generate).

On the next `monoceros apply <containername>` the yml is translated into
`devcontainer.json` — the devcontainer feature
[`ghcr.io/devcontainers-contrib/features/apt-packages:1`](https://github.com/devcontainers-contrib/features/tree/main/src/apt-packages)
with a comma-separated `packages` option runs
`apt-get update && apt-get install -y <list>` during the container build.

## Validation

Allowed characters per package name: `[a-z0-9][a-z0-9.+-]*`. This blocks
shell metacharacters (`;`, `&`, `|`, `$`, `(`, …), so that a typo cannot
sneak a shell injection into the `apt-get install`.

There is **no curated whitelist** — the builder knows what they want to
install. If the name does not exist in the apt repo, the container build
fails with a clear `apt-get` error message
(`E: Unable to locate package …`).

## Idempotency

Repeated invocation with the same packages, or a subset of them →
"No changes — solution is already in the desired state.", exit 0,
no file change.

Repeated invocation with additional packages → the list is accumulated,
diff preview, then write.

## Examples

Add the Postgres client for DB probes:

```sh
monoceros add-apt-packages sandbox --yes -- postgresql-client
monoceros apply sandbox
monoceros run sandbox -- psql -h postgres -U postgres -c '\dt'
```

Build essentials for native Node modules:

```sh
monoceros add-apt-packages sandbox --yes -- build-essential libssl-dev
monoceros apply sandbox
```

## Related commands

- `monoceros add-language <name> <lang>` — language toolchains (Python, Java, Go, …)
- `monoceros add-feature <name> <ref>` — devcontainer features with their own
  install scripts (`gh`, `kubectl`, `docker-in-docker`, …)
- `monoceros apply <name>` — rebuild the container so the packages land in it

## Failure modes

- **`Invalid apt package name: "…"`** — the name contains characters
  outside `[a-z0-9.+-]`. A typo? For special characters, check the name,
  e.g. `lib-...` (hyphen allowed) vs. `lib_…` (underscore not allowed).
- **`No package names given`** — no package was passed after `--`.
  Check the synopsis.
- **Container build fails with `E: Unable to locate package …`** — the
  package does not exist in the configured repos. Look up the correct
  name with `apt-cache search <keyword>` inside the container
  (`monoceros run -- apt-cache search <keyword>`) or use the
  Debian/Ubuntu package search on the web.
