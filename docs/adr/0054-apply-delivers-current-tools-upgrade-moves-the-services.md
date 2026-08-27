# ADR 0054 — `apply` delivers current tools; `upgrade` moves the services

- Status: accepted
- Date: 2026-08-26
- Supersedes: ADR 0018, decisions 1 and 3 (the cached `apply`, and its
  refusal to special-case the first apply)

## Context

ADR 0018 decided that `apply` always reuses the cached image and that
freshness is `upgrade`'s job. It weighed exactly one failure: a tool
being **old**. In practice the sharper failure is the opposite direction,
and 0018 does not mention it: **an `apply` moves a working container
backwards.**

Docker keys a build layer on the install _instruction_, not on what that
instruction resolved to. An unpinned `npm install -g …@latest` therefore
resolves once, when the layer is first built, and freezes. `apply` then
recreates the container from that layer (`--remove-existing-container`).
Three things follow, and all three were observed rather than reasoned
about:

1. **A fresh workbench is silently stale.** The layer cache is
   machine-global, so a workbench set up weeks after the first one on the
   same machine reuses the old layer. Nothing warns. 0018 named this
   ("a brand-new container can start from a stale shared-cache layer")
   and accepted it.
2. **`apply` takes away tooling that was there.** A tool that
   self-updated at runtime wrote into the container's writable layer.
   Recreating the container discards that, so capabilities the builder
   used yesterday are gone after an unrelated yml edit. 0018 does not
   consider this at all; its decision 5 assumes self-update is a pure
   bonus, when in fact `apply` is what erases it.
3. **The first prompt after an `apply` can be wrong.** Between container
   start and the tool's own update notice there is a window in which an
   agent runs without the capabilities the builder assumes. The answer
   can be wrong with nothing pointing at the cause. This is the reason
   the whole thing is not cosmetic.

Measured on 2026-08-26 in `.local/container/caddytest`: the container had
`claude` 2.1.240 while npm published 2.1.247. Seven releases behind after
four days. `gh`, `glab` and `twg`/`acli` release as often and print no
notice at all, so for those nothing would ever move.

It also breaks reproducibility from the other side: two builders with an
identical yml get different tool versions, depending on when their
machine first built that layer. The yml stops being the source of truth
for the one thing it looks like it controls.

Service images have the same cache-shaped hole (`docker compose up`
reuses a locally cached tag), but they are **not** the same problem, and
the difference decides the design: a tool carries no state, a service
carries the builder's.

## Decision

**The yml decides who is in charge.** Where a version is written, the
builder decided and `apply` does not overrule it. Where none is written,
Monoceros decides, and then "current" is the only sensible reading.

**1. Tool features refresh on every `apply`, in a post-create hook.**
A feature whose tool has no version in the yml and talks to a moving
cloud API drops a script into
`/usr/local/share/monoceros/refresh.d/`. The generated `post-create.sh`
runs that directory before the existing `post-create.d/` login hooks: a
login belongs to the tool version the builder is about to use.

Not in the build layer. A cache-busting stamp in the generated
`install.sh` does work — verified 2026-08-26 — but every feature _after_
the stamped one rebuilds too, and the real chain puts java last
(`atlassian_0 → claude-code_1 → opencode_2 → java_3`), so a stamp costs a
~1.5GB image rebuild. The post-create route costs no image build at all,
and it runs on every apply because the container is recreated anyway.

**2. A hook checks before it installs.** One version lookup, and the
install only runs when the versions differ. The common case is therefore
a few hundred milliseconds per tool and no download. Tools with no
version endpoint (`acli`, `twg`, which ship a `latest` URL and an
install script) cannot do that, so they are rate-limited to once a day
via a stamp in the bind-mounted workspace, which outlives the container.

**3. A hook never fails an apply.** No network, a registry outage or a
changed `--version` format leaves the tool from the image in place and
writes a line saying so. The hook runner warns and continues instead of
aborting, and that now applies to the `post-create.d` login hooks too:
under `set -e` one feature's expired credential used to take down every
later hook, the feature notes and the workspace dependency install.

**4. `apply` reports what it refreshed.** The hooks append to
`.monoceros/refresh.log` in the workspace, and `apply` prints it after
the container is up — including "already current". The build log is not
a channel: it scrolls past behind the spinner. Same reasoning, and same
mechanics, as the feature notes (ADR 0018's own late addition).

**5. Service images are pulled by `upgrade`, and on a workbench's first
`apply` only.** A service owns a data directory, and a minor image bump
can migrate it irreversibly — Keycloak rewrites its DB schema on a minor
bump, and the older image then refuses the migrated directory. An apply
the builder ran to change a port must never trigger that. On the first
apply there is no `state.json` and therefore no data to migrate, so the
risk is zero and a months-old cached tag would just be a worse start.
This reverses 0018's "we do not special-case first-apply" explicitly.

**6. A pinned version suppresses the hook entirely.** `install.sh` only
writes the refresh hook when its `version` option is `latest`. Forge is
the one tool that is unpinned and still gets no hook: the version it
should run is decided by this container's Node via `@forge/cli`'s engine
ranges, not by what npm published last, and that answer only changes when
the base image changes — which is `upgrade`'s business.

## Rationale

- **It matches what a builder expects.** "I just set this up" and "I just
  re-applied" both mean "this is current". Nobody reads an ADR before
  typing `apply`.
- **Cheap in the common case.** A version check per tool, not a
  download; no image rebuild at all.
- **The asymmetry is principled, not pragmatic.** Tools are stateless and
  their APIs move server-side, so old is _wrong_. Services are stateful
  and their migrations are one-way, so old is _safe_. Different risk,
  different moment.
- **`upgrade` keeps a clear job**: the base image, the services, and the
  prune. It is no longer the only thing standing between the builder and
  a correct tool.

## Consequences

- Every `apply` on a workbench with tool features does a little network:
  one version lookup per tool, an apt list refresh scoped to the
  cli.github.com source, and at most a daily download for `acli`/`twg`.
  Offline this warns and carries on.
- A first `apply` also pulls the service images, so it is slower than it
  was — and correct, which it was not.
- `refresh.d` is a new contract between the CLI and the features: the
  generated `post-create.sh` runs it, and `MONOCEROS_REFRESH_LOG` is how
  a hook reports. Both live in the CLI, so a feature published to GHCR
  without a matching CLI writes hooks nobody runs. Same coupling the
  `post-create.d` and `notes.d` channels already have.
- Six features change and are republished: `claude-code`, `opencode`,
  `github-cli`, `gitlab-cli`, `atlassian`, `graphify`.
- **Existing workbenches need one `upgrade` first.** The hook is written by
  `install.sh`, which only runs when the feature layer is built. A builder who
  updates the CLI and re-applies keeps the cached layer, and that layer has no
  `refresh.d` in it, so the first apply after the update refreshes nothing. Not
  worth special-casing: the alternative is busting the cache once from the CLI,
  which is the ~1.5GB rebuild this ADR rejected, and `upgrade` already does
  exactly that at a moment the builder picked.
- The staleness nudge from 0018 stays, and now means what it says: the
  base image and the services, not the tools.

## Rejected

- **Cache-busting stamp in the generated `install.sh`.** Works, and
  measured: a comment line changes the bind-mounted feature content and
  that feature's layer rebuilds. But it invalidates every later feature
  in the chain, so with java last it is a ~1.5GB rebuild for a 40MB npm
  package. Rejected on cost, not on mechanism.
- **`--build-no-cache` on every apply.** The same cost, unscoped.
- **Persisting the tool install in a volume** so a self-update survives.
  Tempting, because it would also silence the update notice. But a volume
  wins over the image: after the first start the image layer no longer
  reaches the tool, and `upgrade` would stop being able to move it. That
  trades a visible annoyance for an invisible dead end.
- **Pulling service images on every apply.** Rejected for the data
  migration risk above. The builder decides that moment via `upgrade`.
