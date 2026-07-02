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
2. **Auto-adds the matching CLI feature** (`github-cli` / `gitlab-cli`)
   based on the repo provider, **with its `apiToken` option set from the
   same PAT** (and gitlab's `host` for self-managed). Those features
   already surface the token as `GH_TOKEN` / `GITLAB_TOKEN` (+ `GITLAB_HOST`)
   and wire up gh/glab auth on first container start, so the CLIs are
   authenticated for branch / PR / MR work with no interactive login. A
   feature the builder already declared in the yml is left untouched.
   Because the token is already broad, this costs no extra scope, only a
   small binary, and matches how people work (and how in-container AI
   agents open PRs).

   The feature is **always added** for a provider repo (consistent: present
   or absent never depends on hidden state). When no PAT is configured for
   the host (e.g. the clone used the keychain fallback), the feature is
   added but **not authenticated**, and apply says so explicitly, naming
   the env var to set and the `gh auth login` / `glab auth login` command
   to log in manually. So an unauthenticated CLI is never silent.

Precedence: when a PAT is configured for a host (in either env layer), it
is used directly and **no `git credential fill` is spawned** for that host
(this is what keeps the host tooling-free). Hosts without a configured PAT
fall back to the existing `git credential fill` path (OS keychain / GCM),
which stays fully supported. So the env PAT wins when set, and the keychain
is the fallback, not the other way around.

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
  auto-added per provider. With a PAT they are auto-authenticated; without
  one they are added but not logged in, and apply surfaces that plus the
  `gh auth login` hint (never a silent half-state). Adding them is no
  longer the user's manual chore.
- A container with repos from multiple providers gets each provider's
  feature and token wired independently.

## Status of implementation

Two earlier drafts (host-keyed `MONOCEROS_GIT_TOKEN__<host>`, then an
interactive pick that rewrote the yml) were built and discarded. The
shipped design is **pure convention** — resolved from the env, no
prompting, no yml mutation. What ships (#33):

- **Two-layer env**: global `monoceros-config.env` merged under the
  per-container `<name>.env` (container wins), both gitignored.
- **add-repo / init --with-repos** add the provider's CLI feature
  (github-cli / gitlab-cli) to the yml via the existing `add-feature`,
  whenever a feature exists for the provider.
- **apply resolves each repo's token by convention**, keyed off the URL —
  no prompting, no yml rewrite. Per repo (provider `P`, first URL path
  segment `S`) the cascade is:
  1. `<P>_API_TOKEN` — the builder's explicit per-container/global override
     (`GITHUB_API_TOKEN`, `GITLAB_API_TOKEN`, `BITBUCKET_API_TOKEN`), for
     every provider. For github/gitlab it doubles as the feature placeholder.
  2. `GIT_TOKEN__<P>_<S>` — keyed by the first path segment (github owner /
     gitlab group / bitbucket workspace); uppercased, non-alnum → `_`.
  3. `GIT_TOKEN__<P>` — provider-wide catch-all.
     A repo with no match aborts apply with a hint naming the tried vars.
- **One token, two consumers.** The resolved token is injected into the
  provider CLI feature (→ `GH_TOKEN` / `GITLAB_TOKEN` for `gh`/`glab`) AND
  written into `.monoceros/git-credentials` for the in-container `git
clone`/push. GitHub/GitLab use `oauth2:<token>`; Bitbucket uses the
  static `x-bitbucket-api-token-auth:<token>` (per Atlassian's docs).
- **The host keychain path is gone.** No `git credential fill`/`approve`,
  no "install gh/glab" hints — the host needs no git tooling, and the
  token is the single source of truth. An embedded userinfo in a clone URL
  (`https://user@host/…`) is stripped so git matches the token by host.
- **apply reports which env var supplied each token**, on screen and in
  the apply log (`GitHub (github.com) → GIT_TOKEN__GITHUB_CONCISO`).
- **add-repo uses the same resolution** (`resolveContainerRepoTokens`):
  when a container is running it resolves the token, writes git-credentials
  and clones in the container.
- **The feature token var drops the `_CLI` id leak**: `GITHUB_API_TOKEN` /
  `GITLAB_API_TOKEN` (was `GITHUB_CLI_API_TOKEN`). Other credentialed
  features (claude-code, atlassian) keep the generic `<FEATURE_ID>_<OPTION>`
  derivation.

Follow-ups (out of #33):

- **Gitea**: removed as a provider for now.
- GitHub Enterprise: github.com and Enterprise Cloud (`*.ghe.com`)
  authenticate via `GH_TOKEN`. Self-hosted Enterprise Server needs its
  `GH_ENTERPRISE_TOKEN` + `GH_HOST` — a feature-side follow-up.
- User-facing docs on getmonoceros.build for `monoceros-config.env` + the
  token cascade (the `concepts/git-and-repos` page gets a rewrite).

(The "Revision" notes below are the design history that led here — the
selection/persistence they describe was superseded by the convention
cascade above.)

## Revision: account-labeled tokens + repo-driven selection

The host-keyed `MONOCEROS_GIT_TOKEN__<host>` scheme above is superseded. It
can't hold two accounts for the same host (work + private github.com), and
it duplicated the token outside the feature. Final model:

- **Env convention `GIT_TOKEN__<PROVIDER>_<LABEL>`** (e.g.
  `GIT_TOKEN__GITHUB_CONCISO`, `GIT_TOKEN__GITHUB_PICTOR`). The provider
  segment groups tokens by provider; the free label distinguishes accounts.
- **The token lives in the CLI feature's `apiToken`** (github-cli /
  gitlab-cli), visible in the yml, referencing a global `${GIT_TOKEN__…}`
  var. One value feeds both the in-container CLI and the git clone/push.
  No separate token variable, no per-feature naming special case.
- **apply is repo-driven.** It scans the repo entries, derives each repo's
  provider → CLI feature, and resolves that feature's token: an already-set
  `apiToken` (the standard `${…_API_TOKEN}` var filled in the env, or an
  already-chosen `${GIT_TOKEN__…}`) wins; otherwise it reads the
  `GIT_TOKEN__<PROVIDER>_*` candidates from the merged env and offers them
  as a pick list (with a cancel entry). The chosen `${GIT_TOKEN__…}` is
  persisted into the feature's `apiToken` in the yml so re-apply never
  re-asks. No candidate, or the builder cancels → apply aborts with an
  actionable error (rather than starting a container that can't reach its
  private repos).
- **git-credentials**: the resolved `apiToken` is written into
  `.monoceros/git-credentials` as `https://oauth2:<token>@<host>`, so the
  in-container `git clone`/push authenticates off the same token. The host
  keychain path is gone — a configured token always wins and the host's
  git helper is never consulted. `add-repo` uses the same handling.
- **Featureless providers (Bitbucket)** run off the same repo scan: no CLI
  feature, the token comes from `GIT_TOKEN__BITBUCKET_<WORKSPACE>` (workspace
  = first URL path segment) and is written to git-credentials with the
  `x-bitbucket-api-token-auth` username. Multiple workspaces resolve
  independently by URL. Gitea was dropped as a provider.

Multi-account is handled by the label plus per-container selection. Two
accounts for the SAME host in the SAME container is intentionally not
supported (git's credential store is host-keyed; gh's `GH_TOKEN` is one
account) — use separate containers, which the per-container env covers.

Status: implemented for GitHub + GitLab, end to end. add-repo / init add
the provider CLI feature via the existing `add-feature`; apply scans repos
→ `GIT_TOKEN__<PROVIDER>_*` pick list (with cancel) → persists the chosen
`${VAR}` into the yml feature `apiToken` → writes it to
`.monoceros/git-credentials` as `oauth2:<token>` so the in-container clone
authenticates, or aborts on no-candidate / cancel. A configured token
always wins; the host keychain / `git credential fill` path is removed
entirely. `add-repo` clones in a running container off the same token.
Bitbucket Cloud works via `GIT_TOKEN__BITBUCKET_<WORKSPACE>` +
`x-bitbucket-api-token-auth`, keyed by workspace so multiple workspaces
resolve independently. Not yet done: self-hosted GitHub Enterprise Server
(`GH_ENTERPRISE_TOKEN` + `GH_HOST`). Gitea was dropped as a provider.
