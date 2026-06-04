# ADR 0012 — Clone repos host-side before `compose up`

- Status: **reverted (2026-06-03)** — see "Revert" at the end
- Date: 2026-06-02

> **Revert note (2026-06-03):** This decision was reverted. The
> host-side clone (and the host-side `git ls-remote` reachability
> pre-flight) moved network and credential resolution from the
> **container** side (which works) to the **host** side — and as a
> result produced false early aborts across platforms: VS Code's
> `GIT_ASKPASS` on macOS, and the host git's failure to resolve
> github.com DNS on a Linux VM. The host does not share the same
> network/auth context as the container. Both were removed; repos are
> once again cloned exclusively **in-container** (post-create.sh) — the
> only path that works on all platforms. The original motivation for
> this ADR — a service that bind-mounts a repo file (init.sql) and needs
> it **before** `compose up` — remains open and should be solved
> **container-side** (e.g. a clone init step in Compose that services
> depend on via `depends_on`), not via the host. See backlog.md.

---

_Original text (superseded):_

## Context

Up to this point, repos declared in the container yml (`repos:`) were
cloned exclusively **in-container** — the generated `post-create.sh` ran
`git clone` after `devcontainer up` had brought the container up. This
was consistent (checkout in the target Linux, credentials via the
`.monoceros/git-credentials` mounted into the container) and sufficient
as long as repos were only needed as workspace content.

With the generic service model (env/volumes per service, see
backlog.md), a new case appeared: a service can bind-mount a **file from
a cloned repo**, e.g. Postgres's `projects/app/init.sql` →
`/docker-entrypoint-initdb.d/init.sql`.

This collides fatally with the existing ordering:

1. `compose up` starts Postgres and bind-mounts
   `projects/app/init.sql` — the file does not exist yet.
2. Docker creates an **empty directory** at the missing mount source.
3. `post-create` runs afterward and wants to clone — but the clone guard
   `[ ! -d projects/app ]` sees the directory Docker created and
   **skips the clone**.

Result: repo never cloned, init.sql never executed, `init.sql` is an
empty directory. The bind-mount source must exist **before** the
container starts — the in-container clone is by definition too late.

## Decision

Repos are **cloned host-side during `apply`, before `compose up`** —
after the scaffold is written, into `<container>/projects/<path>/`.

- **All** repos host-side (not just those referenced by service
  volumes) — uniform behavior, no two clone paths. The checkout-fidelity
  concern (line endings, exec bits) that historically argued _for_ the
  in-container clone is minor after the WSL-only pivot (ADR 0011): the
  host is unix-like in all three supported setups (macOS / Linux / WSL).
- **Idempotent**: an existing `projects/<path>/` is left untouched
  (local changes survive re-apply).
- The **in-container clone in post-create stays** as a skip-guard
  fallback (`[ ! -d ]`) — it simply skips whatever is already there
  host-side. No risk, smaller diff surface.
- **Auth**: the host clone uses the same host git + credential helper as
  the existing reachability pre-flight (`git ls-remote`), which runs
  immediately before it and has already validated the credentials. No
  separate credential path.

## Consequences

- Service bind-mounts from repo files (init.sql, config) work as
  expected — the file is present when the container starts.
- The clone thereby becomes a **real host-side fail-fast gate**: if it
  fails, `apply` aborts before `compose up` with the actual git message.
  This makes the separate reachability pre-flight largely redundant; it
  stays for now as a fast early-warning signal, but could later be
  reduced to warn-only or removed.
- The host must have `git` (it does — the pre-flight already uses it).

## Rejected

- **Clone only service-referenced repos host-side** — two clone paths,
  inconsistent, more complexity for no gain.
- **Remove the in-container clone entirely** — a larger change to
  post-create + tests for minimal gain; the skip-guard fallback costs
  nothing.
