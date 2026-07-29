# ADR 0036: Service data lives in docker volumes, not in `<container-dir>/data/`

- Status: accepted
- Date: 2026-07-27
- Amends: [ADR 0003](0003-container-state-model.md) (the "Compose service
  data under `<container-dir>/data/`" section)

## Context

[ADR 0003](0003-container-state-model.md) put compose service data in a
host bind mount, `../data/<svc>` → the service's data path, so a
database's files appear on the host next to `home/` and `projects/`. It
closed with a caveat:

> Linux caveat: Postgres runs as uid 999 inside the container. On Docker
> Desktop (macOS / Windows) the filesharing layer handles the uid
> mapping.

That assumption no longer holds. Under Docker Desktop's current VirtioFS
implementation a `chown` inside a bind mount reports success but does not
reach the host: the ownership is recorded in an xattr on mount-point
creation and a later `chown` does not update it. The official postgres
entrypoint relies on exactly that sequence. It creates `PGDATA` as root,
chowns it to uid 999, and drops to that user, so the server finds a
root-owned data directory and refuses to start:

```
fixing permissions on existing directory /var/lib/postgresql/18/docker ... ok
FATAL:  data directory "/var/lib/postgresql/18/docker" has wrong ownership
HINT:   The server must be started by the user that owns the data directory.
initdb: removing contents of data directory
```

The initialisation then loops. Only the _first_ start of an empty data
directory is affected, so existing containers kept running and the break
surfaced late, on the next new workbench with a database.

Reproducible without Monoceros in the loop:

```sh
docker run --rm -e POSTGRES_PASSWORD=x -v "$PWD/pgtest":/var/lib/postgresql postgres:18
```

Three workarounds were considered and rejected:

- **A `user:` on the service.** Starting the container as uid 999 does
  fix the Mac case (verified), but it breaks native Linux, where the
  apply-created directory belongs to the apply user and only the
  root-started entrypoint can chown it. That means a platform switch in
  the descriptor and a per-service uid, for a symptom in one file-sharing
  layer.
- **A host-side setting.** Switching Docker Desktop's file sharing to
  gRPC FUSE restores the old behaviour, and so does the Apple
  Virtualization framework. Both are machine-wide settings the builder
  has to know about. A workbench that needs a host tweaked by hand before
  a database works is a broken workbench.
- **Writing the ownership xattr from the host.** Depends on Docker
  Desktop internals and is macOS-only.

## Decision

The `data:` volume shorthand renders as a **docker-managed volume**,
`monoceros-<container>-data-<service>`, declared top-level with a pinned
`name:` like the IDE-state volumes:

```yaml
services:
  postgres:
    volumes:
      - monoceros-acme-data-postgres:/var/lib/postgresql
volumes:
  monoceros-acme-data-postgres:
    name: monoceros-acme-data-postgres
```

The files then live on the VM's own filesystem, where a chown is an
ordinary chown. This holds on macOS, Windows and Linux, with one code
path and no host prerequisite, and it retires the rootless-Linux uid
mismatch the same way.

`data` sits in a fixed position **before** the service name, not as a
`-data` suffix. With the suffix, `remove` matched the IDE-state volume
`monoceros-<name>-jetbrains-data` as if `jetbrains` were a service and
copied it into the backup as `data/jetbrains/` (caught in a live run, not
by a test). A fixed prefix also lets a service name contain dashes: the
whole remainder is the name. New `ideStateVolumes` entries must stay out
of the `data-` prefix.

The distinction that decides bind mount versus volume: **who writes the
files.** A database's cluster directory is written, owned and
ownership-checked by the engine, and nobody edits it from the host, so it
belongs in a volume. Project artifacts the developer does edit (a
Keycloak realm export, a theme directory) stay bind mounts, because being
in the repo is the whole point of them.

`monoceros remove` copies each data volume out into the backup at
`container/data/<svc>/`, the same layout the bind mount produced, and
deletes the volumes only afterwards. So a backup stays a plain, readable
directory tree, and `restore` needs no special case.

An `apply` on a container created before this ADR finds a populated
`data/<svc>/` and an absent volume; it then creates the volume and copies
the directory in, once, before anything starts
(`migrateServiceDataVolumes`). The old directory is left in place: deleting
a builder's database on their behalf is not apply's business. The same
path makes a restored backup live again on the next apply.

## Consequences

- **Databases initialise out of the box again**, on every platform, with
  no host settings and no per-service uid.
- **`ls`, `du`, `tar` over `container/<name>/data/` no longer show live
  DB content.** That was ADR 0003's argument for the bind mount and it is
  what this change gives up. Reaching the live files now needs docker
  (`docker run --rm -v monoceros-<name>-data-<svc>:/data alpine ls /data`),
  or a `monoceros remove`/backup, which still writes them as plain files.
- **Backups keep working unchanged for the builder**, at the cost of a
  copy step through a throw-away container during `remove`.
- **Existing containers migrate on their next apply** and log that they
  did. Their old `data/<svc>/` stays behind as a stale copy until the
  builder deletes it. Documented rather than automated.
- **A `docker volume rm` of a data volume is now destructive** in the way
  deleting `data/<svc>/` used to be. `remove` is the supported path; it
  backs up first.
