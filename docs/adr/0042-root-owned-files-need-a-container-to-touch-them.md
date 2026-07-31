# ADR 0042: Root-owned files in the container tree are read, copied and deleted from a container

- Status: accepted
- Date: 2026-07-31
- Builds on: [ADR 0036](0036-service-data-in-docker-volumes.md) (the same
  VirtioFS asymmetry, one layer down)

## Context

A workbench writes files the CLI cannot read back. Two kinds:

- SSH host keys under `<container-dir>/.monoceros/ssh/host/`, mode 0600,
  owned by root, created by the container's entrypoint.
- Service data copied out of a docker volume, e.g. a postgres cluster at
  `drwx------` owned by uid 999.

`monoceros remove` already knew this for the paths it writes: a plain
`fs.cp` raises `EACCES`, so it falls back to `cp -a` as root in a
throw-away `alpine` container, which preserves owner and mode. What was
missing is that this cuts both ways. `monoceros restore` did a plain
`fs.cp` and died on the very backup the CLI had written minutes earlier:

```
EACCES: permission denied, copyfile
  '<backup>/container/.monoceros/ssh/host/ssh_host_ecdsa_key'
```

The same hole appeared twice more in the e2e suite, in a scenario written
to guard this lifecycle: it asserted the cluster was in the backup with a
host-side directory walk (EACCES, swallowed, reported as "no data"), and
it deleted the backup with a host-side `fs.rm` (EACCES on the cluster
directory). Three defects, one cause.

**None of them reproduce on macOS.** Under Docker Desktop's VirtioFS the
container-side ownership never reaches the host, so a root-owned tree
looks like the developer's own files and every host-side read, copy and
delete succeeds. On Linux the uids are real. This is the same asymmetry
that forced ADR 0036, one layer down: 0036 is about a container that
cannot start, this is about the host tooling that cannot read what the
container left behind.

The consequence is a class of bug that passes review, passes local
testing, passes on the maintainer's machine, and fails only in CI or on a
builder's Linux box - which is where Monoceros is expected to work.

## Decision

**Any code path that touches a file the container may have written as
root does so from a container, not from the host process.** The pattern is
the one `remove` established, in both directions:

```
docker run --rm -v <src>:/src:ro -v <dst>:/dst alpine:3.21 \
  sh -c 'cp -a /src/. /dst/'
```

Concretely:

- Try the host-side operation first and fall back on `EACCES`/`EPERM`.
  The happy path stays free of docker, so an ordinary backup restores
  without a daemon, and the fallback carries a log line naming what
  happened.
- A failing container-side operation raises. It must never be swallowed
  into a "nothing there" or a silent success.
- The same rule binds the e2e suite. An assertion about such a tree runs
  its `find` as root in a container; a cleanup step runs its `rm -rf`
  the same way. A host-side walk that catches its own error reports "no
  data" for data that is present, which is worse than no assertion at
  all.

**Verification uses real Linux ownership, not a host fixture.** Populate a
**docker volume** as root or uid 999, then compare `-u 1000:1000` against
root inside a container. A macOS fixture with `chmod 000` proves nothing:
there even container-root cannot read it, for the opposite reason, so the
test says "denied" in both cases and distinguishes nothing.

The paths this covers today: `<container-dir>/.monoceros/ssh/`,
`<backup>/container/data/<service>/`, and anything else a service
entrypoint creates in the container tree.

## Consequences

- `restore` gained the fallback and is no longer a pure filesystem
  operation. It still needs no daemon for a backup without root-owned
  files, which is the common case.
- Reviewing a change that reads or deletes inside the container tree now
  has a question attached: what happens when that file belongs to root?
  On macOS the answer is never visible from running it.
- `alpine:3.21` is pinned in both directions, so a backup written by one
  version restores with the same image.
- The e2e suite pays a container start per assertion on those paths.
  Cheap, and it is the only way the assertion means anything on both
  platforms.
