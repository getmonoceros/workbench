# Monoceros Devcontainer Features

This folder holds the Devcontainer Features maintained by Monoceros.
Each feature is a subfolder with two files:

- `devcontainer-feature.json` — metadata + options schema + optionally
  `mounts` / `containerEnv` / etc.
- `install.sh` — runs as root during the container build

## Referencing a feature in a container yml

Templates and builder yml files **always** use the full OCI ref:

```yaml
features:
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
```

The same ref works in dev and in prod. While developing in the
workbench repo, the scaffold checks whether `images/features/<name>/`
exists locally; if so, the build path is transparently redirected to
the local copy, so changes to a feature can be tested without a GHCR
push. In an installation without a workbench checkout, resolution goes
through the real GHCR pull.

## Publishing (manual for now, later via CI)

With `@devcontainers/cli`:

```sh
npx -y @devcontainers/cli features publish \
  --namespace getmonoceros/monoceros-features \
  ./images/features/claude-code
```

The org name (`getmonoceros`) and the GHCR namespace
(`monoceros-features`) have been fixed since M4; see
[ADR 0004](../../docs/adr/0004-release-modell-m4.md) for the background.

## Adding a new feature

1. Create the subfolder `images/features/<name>/`
2. Write `devcontainer-feature.json` — required fields: `id`,
   `name`, `version`. Optional: `options`, `mounts`, `containerEnv`,
   `entrypoint`, `installsAfter`, `dependsOn`.
3. Write `install.sh` — runs as root, with the options as environment
   variables (lowercased → uppercased with a `$` prefix).
4. Add a template variant if it makes sense
   (`templates/yml/<name>.yml` or an entry in an existing template)
5. Add a short note here in the README

## Current features

| Folder        | Tool                                         | Status |
| ------------- | -------------------------------------------- | ------ |
| `claude-code` | Anthropic Claude Code CLI                    | live   |
| `atlassian`   | Atlassian CLIs (Rovo Dev via `acli` + `twg`) | live   |
| `github-cli`  | GitHub CLI (`gh`)                            | live   |

## Monoceros conventions on top of the Devcontainer Feature spec

In addition to the standard fields, the Monoceros scaffolders evaluate
an extension field `x-monoceros` in `devcontainer-feature.json`:

```jsonc
{
  "id": "claude-code",
  ...
  "x-monoceros": {
    "persistentHomePaths": [".claude"]
  }
}
```

- **`persistentHomePaths`** — a list of subpaths below `/home/node/`
  that the container should keep persistent. On `monoceros apply`, a
  host directory is created at `<container-dir>/home/<path>` and added
  to `devcontainer.json` as a bind mount. This way login + tool state
  survives every apply rebuild and stays isolated per container.
  Details:
  [`docs/adr/0003-container-state-model.md`](../../docs/adr/0003-container-state-model.md).

### Post-create hooks

`install.sh` runs during the image build and does not yet see the bind
mounts — i.e. an auth login that needs to write to
`/home/node/.config/...` does not belong in `install.sh`. Instead,
`install.sh` may drop a script at
`/usr/local/share/monoceros/post-create.d/<feature>.sh`; the
scaffold-generated `post-create.sh` calls all scripts there at
container start. Convention for such hooks: idempotent (skip if already
logged in), clear log lines, exit 0 when there is nothing to do.
