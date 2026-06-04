# `monoceros init`

Creates a container config at
`$MONOCEROS_HOME/container-configs/<name>.yml`. Two modes:

```sh
monoceros init <name>                                   # documented mode
monoceros init <name> --with-languages=… --with-features=… \
  --with-services=… --with-apt-packages=… \
  --with-repos=… --with-ports=…                         # composed mode
```

Without any `--with-*` flag, init writes a documented template (everything
commented out). As soon as **one** category is set, it composes a yml that
is immediately applyable.

## Purpose

A container config is the source of truth for a dev container. It lives
**outside** the container directory and can be freely edited before
`monoceros apply <name>` materializes a container from it.
`monoceros init` is the initial setup step — it produces the yml,
not the container.

## Category flags

Instead of a magic bag, each category has its own flag. They all take
a comma-separated list or repeated occurrences:

| Flag                  | Content                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--with-languages`    | Language runtimes, curated. Optional `:version` (`java:17`). Catalog: `monoceros list-components`.                                        |
| `--with-features`     | Features. Catalog short name (`claude`, `atlassian/twg`) **or** full OCI ref (`ghcr.io/foo/bar:1`).                                       |
| `--with-services`     | Backing services. Curated name (`postgres`) → full block; arbitrary image (`rustfs/rustfs:latest`) → name+image + commented-out scaffold. |
| `--with-apt-packages` | Arbitrary apt packages (`openssl`, `make`). No catalog.                                                                                   |
| `--with-repos`        | Git URLs, cloned into `projects/` on first apply. Canonical hosts only (github.com / gitlab.com / bitbucket.org).                         |
| `--with-ports`        | Internal container ports → Traefik routing. First entry = `<name>.localhost`.                                                             |

Curated vs. arbitrary: for **features** and **services**, the catalog
decides — if the name is known, it is expanded; otherwise it is
interpreted as an OCI ref or image. **Languages** are curated (there are
only a handful of runtimes).

## Documented mode — `monoceros init <name>` (without `--with-*`)

Writes a **documented template**: every catalog component appears
commented out, with an explanation. The builder uncomments the
desired lines, done.

```sh
$ monoceros init sandbox
✔ Wrote documented default to container-configs/sandbox.yml. Un-comment what you need, then `monoceros apply sandbox`.
```

## Composed mode

Wires the named pieces into a yml that is immediately applyable.
Auth options from the feature manifests (e.g. `apiKey`, `apiToken`)
appear commented out beneath the active options.

```sh
$ monoceros init sandbox \
    --with-languages=node \
    --with-services=postgres,rustfs/rustfs:latest \
    --with-features=claude \
    --with-apt-packages=make \
    --with-ports=3000
```

Produces (abridged):

```yaml
schemaVersion: 1
name: sandbox

languages:
  - node

aptPackages:
  - make

services:
  - name: postgres # curated → full block
    image: postgres:18
    port: 5432
    env: # values as ${VAR}; dev defaults land in sandbox.env
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - data:/var/lib/postgresql
    restart: unless-stopped
    healthcheck:
      test:
        ['CMD', 'pg_isready', '-U', '${POSTGRES_USER}', '-d', '${POSTGRES_DB}']
      interval: 10s
      timeout: 5s
      retries: 5
  - name: rustfs # custom image → name+image + scaffold
    image: rustfs/rustfs:latest
    # port: 8080
    # env:
    #   KEY: ${SOME_VAR}
    # volumes:
    #   - data:/data

features:
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
    options:
      apiKey: ${CLAUDE_CODE_API_KEY} # empty in .env → OAuth login

routing:
  ports:
    - 3000
```

## The `<name>.env` alongside it

`init` creates a gitignored `<name>.env` next to the yml (header +
seeded keys) and writes the yml's `${VAR}` references into it:

- **Curated services** with their dev defaults
  (`POSTGRES_USER=monoceros`, …) — the container runs right away, and a
  value is changed in exactly one place when needed.
- **Feature credentials** as empty `KEY=` lines — you fill in the values.

This keeps the yml shareable (no secrets in it); when you copy a
container, take `<name>.yml` **and** `<name>.env` along and adjust the
`.env`. The file travels with `remove` backups, and `*.env` is listed in
`container-configs/.gitignore`.

### Git identity (when repos are included)

When repos are involved, init additionally writes a container `git.user`
with placeholders and seeds the matching (empty) keys:

```yaml
git:
  user:
    name: ${GIT_USER_NAME}
    email: ${GIT_USER_EMAIL}
```

```sh
GIT_USER_NAME=
GIT_USER_EMAIL=
```

init does **not** ask for the identity — you fill in the `.env`, or
leave it empty: at apply time the cascade then runs upward
(monoceros-config → host `git config --global` → one-time prompt). Details:
[add-repo.md → commit identity](./add-repo.md#commit-identität-username--useremail).

## Versions for languages

Language entries accept an optional `:version` suffix, which is passed
through to the upstream devcontainer feature as the `version` option:

```sh
monoceros init sandbox --with-languages=java:17,node:20,python:3.12
```

Special case `node`: without a version it stays a built-in of the base
image runtime (Node 22); `node:<version>` switches to the upstream feature.

## Sub-components (features)

Some features have sub-components for partial installs:

| Entry               | Effect                             |
| ------------------- | ---------------------------------- |
| `atlassian`         | Rovo Dev + twg (both active)       |
| `atlassian/rovodev` | only Rovo Dev (twg explicitly off) |
| `atlassian/twg`     | only twg (Rovo Dev explicitly off) |

Combining is additive:
`--with-features=atlassian/rovodev,atlassian/twg` yields the same as
`--with-features=atlassian`. When merging colliding boolean options,
`true` wins.

## Notations

All flags accept comma-separated lists, repetition, and shell-separated
tokens with spaces:

```sh
monoceros init sandbox --with-languages=java,node
monoceros init sandbox --with-languages=java --with-languages=node
monoceros init sandbox --with-languages="java, node"
```

## Related commands

- [`monoceros list-components`](./list-components.md) — show the catalog
- [`monoceros apply <name>`](./apply.md) — materialize the config
- [`monoceros add-service`](./add-service.md) / `add-feature` / … —
  mutate the config afterward (comment-preserving)

## Failure modes

- **`Unknown language: <name>`** — not a known runtime. Known ones
  are listed.
- **`Unknown feature: <name>`** — not a catalog short name and not a valid
  OCI ref. Use a short name or `ghcr.io/…/<name>:<tag>`.
- **`Invalid apt package name`** — only `[a-z0-9][a-z0-9.+-]*`.
- **`Two --with-services entries resolve to the service name '<x>'`** —
  name collision. Add one service after init with
  `monoceros add-service <name> <image> --as=<other>`.
- **`Config already exists: <path>`** — target file exists. Delete the yml
  or choose a different `<name>`.
- **`Invalid config name`** — only `[A-Za-z0-9._-]+`.
- **`--with-repos only supports github.com / gitlab.com / bitbucket.org`**
  — non-canonical host. First `monoceros init <name>`, then
  `monoceros add-repo <name> <url> --provider=…`.
