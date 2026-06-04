# `monoceros add-feature`

Adds an arbitrary devcontainer feature to the solution.

## Purpose

Bridges the gap between `add-language` (curated languages) and
`add-apt-packages` (plain apt installation) — for tools that ship their
own devcontainer feature and therefore do more than just
`apt-get install`:

- Set up their own apt repos (e.g. GitHub CLI, Microsoft Edge, HashiCorp Vault)
- Download and install binaries directly (`kubectl`, `helm`, `terraform`)
- Side-container setup (e.g. `docker-in-docker`)
- Configure shell/IDE integration (`common-utils`, `git-lfs`)

## Synopsis

```sh
monoceros add-feature <containername> <feature> [--yes] [-- <key>=<value> …]
```

- `<containername>` — config name under
  `$MONOCEROS_HOME/container-configs/<name>.yml`
- `<feature>` — either a **catalog short name** from
  `monoceros list-components` (e.g. `atlassian`, `atlassian/twg`,
  `claude`, `github`) or a **full OCI ref** (e.g.
  `ghcr.io/devcontainers/features/docker-in-docker:2`).
  With a short name, the feature brings its catalog default options;
  those are overridden by `-- key=value` pairs.
- Options after `--` as `key=value` pairs

## Options

| Flag           | Meaning                 |
| -------------- | ----------------------- |
| `--yes` / `-y` | Skip the confirm prompt |

## Credential options + `${VAR}`

Curated features declare their credential options (`apiToken`,
`apiKey`, …) in the manifest. `add-feature` writes them as **active
`${VAR}` placeholders** into the `options:` block and **seeds the matching
keys into `<name>.env`** (gitignored) — identical to `init`:

```yaml
features:
  - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1
    options:
      rovodev: true
      twg: true
      instance: ${ATLASSIAN_INSTANCE}
      apiToken: ${ATLASSIAN_API_TOKEN}
      …
```

```sh
# container-configs/<name>.env  (keys seeded in advance, only values missing)
ATLASSIAN_INSTANCE=
ATLASSIAN_API_TOKEN=
…
```

Var name = `<FEATURE>_<OPTION>` (consistent). You fill in the value in the
`.env`, `monoceros apply` substitutes it — that way the yml stays shareable
without shipping tokens. **Left empty = not set:** an empty (or
missing) `${VAR}` resolves to "omit" at apply time — the option falls
back to a `defaults.features` value from `monoceros-config.yml` or
stays unset (e.g. empty `apiKey` → OAuth login). Nothing needs to be
commented out. `remove-feature` does not touch the `.env`.

## Feature catalog

There is no single "official" index, but three reliable sources:

1. [containers.dev/features](https://containers.dev/features) — A searchable
   overview of all known features with publisher and description.
2. [`devcontainers/features`](https://github.com/devcontainers/features) —
   Microsoft-curated features. The standard for languages, gh, docker-in-docker,
   kubectl, aws-cli, terraform, common-utils, git, …
3. [`devcontainers-contrib/features`](https://github.com/devcontainers-contrib/features) —
   Community-curated features. Long-tail tooling: apt-packages,
   npm-packages, pre-commit, direnv, starship-shell, …

Each feature has its own README in the source repo that documents the
accepted options — the only reliable spec for that particular feature.

## What `:2` means (version tag)

Devcontainer features are OCI artifacts, published on `ghcr.io`. The
tag corresponds to the major version:

```
ghcr.io/devcontainers/features/docker-in-docker:2
                                                ^
                                                major version 2
```

Pin to a concrete major version (`:1`, `:2`) for reproducibility
— the feature authors promise backwards compatibility within a
major. `:latest` points to the newest available major and
can break without warning.

## Options syntax (smart coercion)

Options come after `--` as `key=value` tokens. The value is
type-coerced, because devcontainer features expect the right JSON types
(`{ "moby": true }`, not `{ "moby": "true" }`):

| Input              | Value in `devcontainer.json`                   |
| ------------------ | ---------------------------------------------- |
| `key=true`         | `true` (boolean)                               |
| `key=false`        | `false` (boolean)                              |
| `key=42`           | `42` (number)                                  |
| `key=-7`           | `-7` (number)                                  |
| `key=latest`       | `"latest"` (string)                            |
| `key=1.2.3`        | `"1.2.3"` (string — the dot keeps it a string) |
| `key=/usr/local/x` | `"/usr/local/x"` (string)                      |

## Examples

A simple feature without options:

```sh
monoceros add-feature sandbox ghcr.io/devcontainers/features/github-cli:1 --yes
monoceros apply sandbox
monoceros run sandbox -- gh --version
```

With options:

```sh
monoceros add-feature sandbox ghcr.io/devcontainers/features/docker-in-docker:2 \
  --yes -- version=latest moby=true installDockerBuildx=true
monoceros apply sandbox
```

Accumulating multiple features:

```sh
monoceros add-feature sandbox ghcr.io/devcontainers/features/github-cli:1 --yes
monoceros add-feature sandbox ghcr.io/devcontainers/features/kubectl-helm-minikube:1 --yes
monoceros add-feature sandbox ghcr.io/devcontainers/features/aws-cli:1 --yes
monoceros apply sandbox
```

At container build time all features run in sequence — the order is
determined by the devcontainer CLI based on feature-spec dependencies.

## Idempotency and option conflicts

- **Same ref, identical options** → no-op, no write.
- **Same ref, differing options** → **error.** Rationale: silently
  overwriting a tuned options map is dangerous. If you want to
  change options, first run
  `monoceros remove-feature <name> <ref>`, then `add-feature` again.
- **Different ref** → the feature is added, the list accumulates.

## Validation

Feature refs must match the OCI pattern `<host>/<path>:<tag>`:

```
^[a-z0-9.-]+(/[a-z0-9._-]+)+:[a-z0-9._-]+$
```

Blocks shell metacharacters and whitespace — protects against an
unsanitized ref landing directly in `devcontainer.json` and being
misinterpreted by the build tool.

## Related commands

- `monoceros add-language <name> <lang>` — curated language features
  (Python, Java, Go, Rust, .NET). More ergonomic than the full feature ref.
- `monoceros add-apt-packages <name> -- <pkg> …` — when the tool has no
  feature of its own and a plain `apt install` is enough.
- `monoceros remove-feature <name> <ref>` — the inverse, and also the way
  to change options.
- `monoceros apply <name>` — rebuild the container so the feature
  actually lands in it.

## Failure modes

- **`Invalid devcontainer feature ref`** — the ref does not match the
  OCI pattern. Common causes: forgotten tag (`…/feature` instead of
  `…/feature:1`), typo in the path, whitespace.
- **`Feature ${ref} is already configured with different options`** —
  you are trying to add the same ref with different option values.
  Fix: first run `monoceros remove-feature <name> <ref>`, then
  `add-feature` again.
- **`Invalid option: "…". Expected key=value`** — a token after `--` is
  not a `key=value` pair. Check the spelling, possibly the shell quoting
  (`"key=value with spaces"`).
- **Container build fails with "Failed to fetch feature"** — the
  ref is syntactically fine, but the feature is unreachable (typo in
  the path, network problem, GHCR temporarily down). Diagnosis: open the
  ref in a browser (`https://ghcr.io/…`) or run
  `docker pull <ref>` on the host side.
