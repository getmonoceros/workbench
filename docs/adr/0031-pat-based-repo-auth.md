# ADR 0031: PAT-based repo auth, no host git CLI

- Status: accepted
- Date: 2026-06-30

## Context

Repos are HTTPS-only (ADR 0006) and cloned **in the container** by
`post-create.sh` using native `git clone`, with the credential helper
wired to a forwarded store file:

```sh
git config --global credential.helper "store --file=/workspaces/<name>/.monoceros/git-credentials"
```

`monoceros apply` populates `.monoceros/git-credentials` host-side. Today
the only documented way to get a credential into that store for GitHub and
GitLab is the provider's **CLI**: the apply pre-flight, when `git
credential fill` returns nothing for a host, tells the user to install
`gh` / `glab` and run `gh auth login` / `glab auth login`. Bitbucket and
Gitea already use a token + `git credential approve` flow instead; gh/glab
are the outliers.

This breaks down in practice:

1. **It breaks the "host needs only Docker + Node" promise.** Installing
   `gh`/`glab` on the host is real friction. On macOS the lean path is
   Homebrew; on Linux gh wants a vendor apt-repo setup and glab has no
   official apt repo at all (GitLab itself recommends Homebrew). Homebrew
   on Linux is a heavy, second-class dependency.
2. **On Windows it breaks the "never touch WSL" promise.** Monoceros runs
   inside the managed WSL distro, so "install gh and run gh auth login"
   means the user must open a WSL shell and install tooling: exactly what
   the managed-distro + shim design set out to avoid.
3. **Users can't grok credential scope.** User tests showed the
   read-only-vs-write distinction is not graspable for most. People want
   to push, branch, and open PRs/MRs, so a clone-only token is practically
   useless. The least-privilege argument is theoretical: real work needs a
   broad token anyway.

The container side (native git + `credential.helper=store`) is already
provider-agnostic. The only question is **where the credential lines come
from**.

## Decision

Authenticate repos with a **Personal Access Token per provider**, supplied
through env files (user-local, gitignored, editable via the `~/.monoceros`
symlink, so Windows users never open a WSL shell). No host-side
`gh`/`glab`, no Homebrew/apt for these, no interactive login anywhere.

**Two env layers, mirroring the existing yml layers**, so a token can be
shared globally or scoped per container:

| Layer         | yml (today)                           | env                          |
| ------------- | ------------------------------------- | ---------------------------- |
| global        | `monoceros-config.yml` (`defaults.*`) | `monoceros-config.env` (new) |
| per-container | `<name>.yml`                          | `<name>.env` (exists)        |

The per-container `container-configs/<name>.env` already exists and feeds
`${VAR}` resolution for feature/service secrets and `git.user`; it becomes
the container-scoped token store. A new global `monoceros-config.env` (next
to `monoceros-config.yml`) is the shared default. Resolution precedence is
the same the yml cascade already uses: **`<name>.env` overrides
`monoceros-config.env`.** The 90% case (one account per provider) sets the
token once globally; the multi-client case (same host, different tokens per
container) overrides per container, with secret values staying in env files
and never in the yml.

The token is **broad on purpose** (GitLab `api`, GitHub classic `repo`),
matching what users actually do. The setup hint tells the user to "create
a token that can do what you do on the website."

On `apply` (and when a repo is added via `--with-repos` / `add-repo`),
Monoceros knows the provider from the repo URL and does all of:

1. **Writes the token into `.monoceros/git-credentials`** (e.g.
   `https://oauth2:<token>@gitlab.com`, token-only form for GitHub). Native
   in-container git then does clone, push, and pull. The user supplies only
   the token, never a username; Monoceros applies a fixed per-provider
   username convention.
2. **Injects `GH_TOKEN` / `GITLAB_TOKEN` into the container env**, so the
   gh/glab CLIs are auto-authenticated for branch / PR / MR work.
3. **Auto-adds the matching CLI feature** (`github-cli` / `gitlab-cli`)
   based on the repo provider. Because the token is already broad, this
   costs no extra scope, only a small binary, and matches how people work
   (and how in-container AI agents open PRs).

The existing host `git credential fill` path (OS keychain / GCM) stays
supported and takes precedence when present; the env-based PAT is the
tooling-free default for everyone else.

## Consequences

- **Host requirement returns to Docker + Node.** No git provider CLI, no
  Homebrew/apt dance, on any platform.
- **The "never touch WSL" promise holds on Windows.** The only user action
  is: generate a token in the browser, paste one line into
  `monoceros-config.env` (via the symlink), re-run apply.
- **One token configures the whole container:** native git, gh, and glab
  are all authenticated from the same PAT, with zero interactive login on
  host or in container.
- **Security is a deliberate trade-off.** A broad token sits as plaintext
  on disk. Mitigations: `monoceros-config.env` is gitignored, supports
  `${VAR}` interpolation so the token need not live in the file itself, and
  the hint recommends setting an expiry. Stronger protection would mean
  OS-keychain-backed OAuth, which the tooling-free goal deliberately
  rejects.
- gh/glab move from a host prerequisite to **container features**,
  auto-added and auto-authenticated. Adding them is no longer the user's
  manual chore.
- A container with repos from multiple providers gets each provider's
  feature and token wired independently.

## Status of implementation

Design only; not yet built. Settled: the two-layer env model (global
`monoceros-config.env` + per-container `<name>.env`, container wins).

Open implementation details:

- The exact host-keyed variable naming (e.g.
  `MONOCEROS_GIT_TOKEN__github_com`, underscores for self-hosted hosts),
  and how a per-container `<name>.env` selects a different token for the
  same host.
- The precise per-provider username convention and scope names (verified
  against the live provider docs at build time, not from memory).
- The exact apply step where both env layers are read, merged
  (container over global), and written into `git-credentials` plus the
  container env. Today apply reads only `<name>.env`; it must also read
  `monoceros-config.env` underneath it.
