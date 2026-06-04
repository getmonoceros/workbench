# ADR 0003 — Per-container home: persistent tool state under `container/<name>/home/`

- Status: accepted
- Date: 2026-05-17

## Context

Up to M3-pre we had two attempts at sharing tool auth between host and
container, both unsatisfactory:

1. **Bind-mount of a host-home subpath.** `claude-code` originally
   mounted `~/.claude` directly from the host into the container.
   Convenient, but: every container writes back to the host, a
   `claude /logout` inside the container takes the host login with it,
   multiple containers overwrite each other, and container-specific
   session paths pollute the host's projects list. This breaks the
   promise of "container isolation as the default" and doesn't scale
   with multiple containers.

2. **Piping an API token from `monoceros-config.yml`.** Works for ACLI
   (`acli rovodev auth login --token` is non-interactive), but not for
   OAuth browser flows (Claude Code subscription, twg). It also doesn't
   make content like skills/agents/CLAUDE.md persistent.

## Decision

Each container gets its own home directory, visible on the host under
`<container-dir>/home/`:

```
<MONOCEROS_HOME>/container/<name>/
  .devcontainer/   ← recipe (apply rewrites it on every run)
  .monoceros/      ← Monoceros bookkeeping (apply writes: state.json, git-credentials, gitconfig)
  home/            ← container home (container writes at runtime, apply leaves it alone)
  data/            ← compose service data (postgres/, mysql/, redis/ — bind mounts)
  projects/        ← workspaces (`monoceros add-repo` clones in here)
  <name>.code-workspace
  .gitignore       ← excludes /home/, /.monoceros/ and /data/
```

Each Monoceros feature declares a Monoceros-specific field in its
`devcontainer-feature.json`:

```json
"x-monoceros": {
  "persistentHomePaths": [".claude"]
}
```

On `monoceros apply` the scaffold reads this list, creates
`<container-dir>/home/.claude/`, and generates a bind mount in the
`devcontainer.json`:

```json
"mounts": [
  "source=${localWorkspaceFolder}/home/.claude,target=/home/node/.claude,type=bind"
]
```

In compose mode the same mount runs as a volume on the `workspace`
service in `compose.yaml`.

### Compose service data under `<container-dir>/data/`

DB data (Postgres, MySQL, Redis) is container state too and therefore
belongs under `<container-dir>/`. For it we no longer use
**docker named volumes** but bind mounts:

```yaml
services:
  postgres:
    volumes:
      - ../data/postgres:/var/lib/postgresql
```

This makes `data/postgres/`, `data/mysql/`, etc. appear directly in the
container directory on the host disk. Consequences:

- `ls`, `du`, `tar`, `cp -r` over `container/<name>/data/` work without
  docker-volume indirection.
- The backup that `monoceros remove` writes automatically contains the
  DB data (it's a plain file copy).
- The service entry in the `SERVICE_CATALOG` only declares the
  container-side mount path (`dataMount`); the scaffold generates the
  host path deterministically from the service name.

Linux caveat: Postgres runs as uid 999 inside the container. On Docker
Desktop (macOS / Windows) the filesharing layer handles the uid
mapping. On a bare Linux host the pre-created `data/postgres/` path,
owned by the host user, may be unwritable for the container → we
document this if a builder trips over it.

## Consequences

- **The host stays untouched.** There is no longer any bind mount onto
  host-home subpaths. What happens in the container stays in the
  container.
- **Login survives `monoceros apply`.** Re-apply writes only the
  scaffold (`.devcontainer/`, `.monoceros/`, scaffold files); `home/`
  is left alone. Container rebuild → the mount picks the existing login
  back up.
- **One login per container.** Sandbox and Client-X can use different
  Atlassian tenants / Anthropic accounts without clashing.
- **Skills/agents/CLAUDE.md are not automatically shared between
  containers.** The builder copies them explicitly between
  `container/<a>/home/.claude/skills/` and `container/<b>/...`, or sets
  up symlinks themselves. Deliberate — magic sharing would reintroduce
  cross-contamination; manual copying is explicit and predictable.
- **Secrets live on the host disk** under
  `container/<name>/home/<tool>/<credentials-file>`. The `.gitignore`
  at the container root excludes `/home/` so an accidental `git init`
  in the container root commits nothing. The builder still has to be
  aware that, e.g., a `tar` over the container dir picks up secrets
  too.
- **Auto-login for tools with a non-interactive login path.** When the
  container yml (or `monoceros-config.yml → defaults.features`) sets,
  e.g., `instance`, `email` and `apiToken` for the `atlassian` feature,
  the feature's `install.sh` drops a script under
  `/usr/local/share/monoceros/post-create.d/<feature>.sh`. The
  scaffold's `post-create.sh` runs all scripts found there on container
  start. Idempotent: if the auth file under `home/.config/acli/...` is
  already valid, the login is skipped.
- **Directory ownership.** The scaffold pre-creates the subpaths in
  `home/` so Docker doesn't create a root-owned mount source on
  container start. On macOS Docker Desktop handles the UID mapping
  transparently; on Linux the host UID must match the container's
  `node` UID (1000), otherwise there are permission problems inside the
  container — the same caveat as for any other bind mount.

## Non-goals of this ADR

- **Shared skills between host and containers.** Whoever wants this
  deliberately creates a symlink `container/<name>/home/.claude/skills →
~/.claude/skills`. Monoceros does not offer this as a default.
- **Multi-account git.** Today every container uses the host's
  credential-helper data via `git credential fill`. Different tokens
  per remote need their own mechanism; noted as open in the backlog.
- **`monoceros duplicate <a> <b>`.** An idea from the design discussion
  on this model: clone the container dir, reset projects/.devcontainer,
  keep the login. Earmarked in the backlog.
