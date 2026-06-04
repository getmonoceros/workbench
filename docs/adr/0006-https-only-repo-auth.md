# ADR 0006 — HTTPS-only repo auth

- Status: accepted
- Date: 2026-05-23

## Context

Monoceros clones Git repos into `projects/<path>/` during the
`post-create` phase of the dev container. Repos are configured via
`init --with-repo=<url>` or `monoceros add-repo <name> <url>` and
persisted in the container yml under `repos:`.

During the end-to-end walkthrough for M4 Task 9 (native Linux and
macOS Docker Desktop), a series of friction points came up that all
trace back to one common issue: **SSH-style URLs
(`git@github.com:…`, `ssh://…`) force host-OS-specific auth
mechanics that contradict the "declarative + reproducible" promise
from [`docs/concept.md`](../concept.md).**

Specifically observed:

- **macOS Docker Desktop**: The host-side `SSH_AUTH_SOCK` lives
  under `/private/tmp/com.apple.launchd.<id>/Listeners`, a launchd-
  managed path that is not in Docker Desktop's file-sharing list.
  A direct bind mount of the socket fails with
  `bind source path does not exist`. Workaround: Docker Desktop's
  bundled SSH agent proxy (`/run/host-services/ssh-auth.sock`) —
  but that is only available if the builder toggles "Use SSH agent"
  in Docker Desktop → Settings → Resources. A manual GUI config
  step violates the declarative assumption.

- **Windows Docker Desktop**: The Windows SSH agent exposes a named
  pipe (`\\.\pipe\openssh-ssh-agent`), not a Unix socket. A bind
  mount in Linux container mode does not work directly. Here too
  there is a Docker Desktop toggle as a workaround — the same manual
  setup step.

- **Native Linux**: Works without setup — `SSH_AUTH_SOCK` is
  directly mountable, no VM sandboxing. An asymmetry between the
  three platforms.

- **Multi-identity (multiple GitHub accounts per builder)**:
  Requires either `~/.ssh/config` host aliases with URL rewriting
  (`git@github-work:org/repo.git` instead of the real GitHub URL) or
  per-repo `core.sshCommand` pinning. Monoceros would have to wrap
  either cleanly — the blueprint would be a new `sshKey:` schema
  field on three levels, mounted key files per unique key, pre-flight
  checks (key present, not passphrase-encrypted, correct
  permissions), a consistency constraint between `sshKey` and
  `user.email` … several hundred lines of code plus test surface plus
  docs.

- **Passphrase-encrypted keys**: In the non-interactive post-create
  context there is no clean way to supply the passphrase. It would
  have to be documented explicitly as "not supported".

In parallel, there is already a working HTTPS auth path (M1, commit
`3aaaf72`): `apply` runs `git credential fill protocol=https
host=<host>` on the host for each unique HTTPS host and writes the
responses to `<container-dir>/.monoceros/git-credentials`. Inside the
container, post-create.sh configures `git config --global
credential.helper "store --file=…"` with the same path. On clone,
git finds the credentials, authenticates, and clones. This works
**across platforms without Docker Desktop settings**, because bind
mounts under the container root are reachable by default.

In a realistic builder environment in 2026 there is essentially no
Git host that supports SSH exclusively: GitHub.com, GitLab.com,
Bitbucket.org, self-hosted Gitea, self-hosted GitLab, Bitbucket
Server — all support HTTPS first-class with personal access tokens,
deploy tokens, or app passwords for auth. The host-side credential
helper (`osxkeychain`, `libsecret`, `wincred`, or `gh auth setup-git`
for GitHub) returns the right answer for each of these hosts.

## Decision

**Monoceros supports repo URLs only in HTTPS format.** SSH-style
URLs (`git@host:…`, `ssh://…`, `git://…`) are rejected at the schema
level (`config/schema.ts` REPO_URL_RE requires `^https://`).

Rationale — a trade-off between coverage and complexity:

- **What we give up**: SSH-style URLs from the clone dialog of
  GitHub/GitLab/etc. — the builder has to deliberately copy the
  HTTPS URL, not the SSH URL. Edge-case hosts that support only SSH
  (self-hosted Gitea without an HTTP frontend, etc.) are not covered.
  Builder muscle memory wired for SSH URLs has to relearn.

- **What we gain**: Consistent behavior across Linux, macOS Docker
  Desktop, and Windows Docker Desktop. No host GUI configuration
  steps. No schema extension for `sshKey` fields on three levels. No
  passphrase edge cases. No multi-identity wiring via
  `core.sshCommand`. No platform-specific SSH agent forwarding.
  Per-repo `git.user` identity still works (Task 8) — multi-identity
  use cases stay covered, because commit identity is independent of
  the SSH key choice.

Concretely in the schema:

```ts
// REPO_URL_RE: must start with https://
const REPO_URL_RE = /^https:\/\/[A-Za-z0-9@:/+_~.#=&?-]+$/;
```

Error message on violation:

> Invalid repo URL. Only HTTPS URLs are supported (`https://...`).
> SSH-style URLs (`git@host:...`, `ssh://...`) are not in scope —
> see ADR 0006.

## Consequences

- **`packages/cli/src/create/scaffold.ts`**: SSH agent forwarding
  infrastructure (`hasSshRepo`, `sshAgentMountSource`,
  `buildRepoAuthMounts`, `buildRepoAuthEnv`, `SSH_AGENT_TARGET`,
  `GIT_SSH_COMMAND`) removed entirely. The Compose yaml generator no
  longer sets `SSH_AUTH_SOCK`/`GIT_SSH_COMMAND` either. ContainerEnv
  and `mounts` in devcontainer.json are free of SSH specifics.

- **Defense in depth in `devcontainer/credentials.ts`**: The
  `uniqueHttpsHosts` function still filters out non-HTTPS URLs
  defensively. That does no harm — the schema catches SSH URLs before
  the runtime layer, but the filter is belt-and-suspenders for faulty
  test fixtures or future callers.

- **Docs** (`README.md`, `docs/commands/add-repo.md`): an explicit
  statement that "repo URLs must be HTTPS, SSH is not in scope". For
  each major provider, a note on where to find the HTTPS URL (in the
  GitHub clone dialog: the HTTPS tab).

- **Provider declaration** (schema field `repos[].provider`,
  `RepoEntrySchema`): canonical hosts (`github.com`, `gitlab.com`,
  `bitbucket.org`) are auto-detected. All other HTTPS hosts
  (self-hosted GitLab at `git.firma.de`, Gitea/Forgejo at
  `code.acme.com`, Bitbucket Data Center …) require an explicit
  `provider:` entry, otherwise the apply pre-flight aborts with a
  clear error message. Background: the hostname alone does not allow
  a reliable provider inference — an earlier heuristic
  (`startsWith('gitlab.')`) missed exactly the self-hosted cases that
  most often need the provider hint. Supported provider values:
  `github` (Cloud + Enterprise), `gitlab` (Cloud + Self-Hosted),
  `bitbucket` (Cloud + Data Center), `gitea` (also covers Forgejo —
  same API + UI). `monoceros add-repo` sets the field via the
  `--provider=…` flag; `monoceros init --with-repo` accepts only
  canonical hosts, because provider input via a CLI flag in `init` is
  rare enough that it is not worth burdening the syntax with it.

- **Backlog M5 Task 4 (test plan rewrite)**: The "explicitly test
  the SSH repo path" item added in M4 Task 9 is dropped. Instead:
  "HTTPS repo — clone + commit + push" as a mandatory case per
  platform, plus "SSH URL in the yml → clear error message" as a
  validation test.

## Re-evaluation if there is real builder demand

If a builder shows up to Monoceros and says "my primary workflow
goes through SSH auth and I can't/won't switch to HTTPS", the design
draft from the discussion thread (chat history 2026-05-23) is on the
table:

- `sshKey:` field in `defaults.git`, container `git`, `repos[].git`
  with a fallback hierarchy
- pre-flight check for key existence + permissions + not encrypted
- bind mount under `~/.ssh/<key>` per unique key
- per-repo `core.sshCommand "ssh -i ~/.ssh/<key> -o IdentitiesOnly=yes"`
  in post-create.sh after clone and persist
- consistency docs: `sshKey` + `user.email` must represent the same
  GitHub identity

Estimated effort: ~250–300 LOC + a comparable amount of test surface,
plus a dedicated ADR (0006a or similar) that re-evaluates the
trade-offs. Not relevant today — if there is real demand it would be
opened as its own backlog item.
