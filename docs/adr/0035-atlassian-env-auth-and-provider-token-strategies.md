# ADR 0035: Atlassian auth via env, Bitbucket fronted by twg, per-provider token strategies

- Status: accepted
- Date: 2026-07-22
- Refs: #36 (reworks the Atlassian feature), amends ADR 0031 (repo auth)

## Context

The Atlassian feature (`atlassian`: Rovo Dev / twg / Forge) is the odd
one out in the token story (#36):

- Unlike github/gitlab it is **not repo-driven** — no auto-activation,
  its credentials (`email` / `apiToken` / `instance`) are hand-entered
  feature options with no in-product guidance.
- Its global default home is `monoceros-config.yml` under
  `defaults.features.<ref>`, whereas git provider tokens live in
  `monoceros-config.env` (ADR 0031). The **same kind of secret has two
  different homes** depending on whether it is a "feature option" or a
  "git token".

Three external facts reshape the design (verified against Atlassian
docs, July 2026):

1. **Bitbucket app passwords are being retired.** Creation stopped
   2025-09-09; all remaining app passwords are disabled 2026-06-09. The
   replacement for git access is an **Atlassian API token with Bitbucket
   scopes** (`read:repository:bitbucket`, plus `write:…` for push), used
   with the fixed git username `x-bitbucket-api-token-auth`. The old
   `bitbucketToken` = "app password" model is dead. (The
   `x-bitbucket-api-token-auth` username is already wired,
   `schema.ts` `GIT_CREDENTIAL_USERNAME.bitbucket`.)
2. **Atlassian API tokens are user-scoped.** One token grants access to
   every instance the user can reach; the **instance** decides what data
   a call sees. So per account there is one token, and what varies
   between targets is the instance (and, for Bitbucket, the workspace).
3. **Custom domains exist.** Jira/Confluence Cloud support custom
   domains on Premium/Enterprise (e.g. `go.jira.acme.com`). We **cannot**
   rely on the `<site>.atlassian.net` scheme — `instance` is an opaque
   host string, never parsed or validated against that pattern.

A container always runs against exactly one Atlassian context (twg reads
one `TWG_SITE`, one account). There is no in-container multiplexing, so a
container never needs more than one instance — the container _is_ the
unit that selects a target.

## Decision

### 1. Atlassian auth is env-driven, three values

Atlassian credentials resolve from env, in two layers (the ADR-0031
pattern), not from `monoceros-config.yml`:

| Value        | env var                                |
| ------------ | -------------------------------------- |
| account mail | `ATLASSIAN_EMAIL`                      |
| API token    | `ATLASSIAN_API_TOKEN`                  |
| target site  | `ATLASSIAN_INSTANCE`                   |
| Bitbucket    | `ATLASSIAN_BITBUCKET_TOKEN` (optional) |

These are already the derived feature-option var names
(`featureOptionVarName('atlassian', …)`), already resolved
`monoceros-config.env` → `<name>.env` (container wins) via
`mergeEnvLayers` + `interpolateFeatureOptions`. **No new cascade is
built for twg** — the feature-env path already authenticates it
(`workspaceEnv` → `TWG_USER/TWG_SITE/TWG_TOKEN/TWG_BBC_TOKEN`,
`FORGE_EMAIL/FORGE_API_TOKEN`).

All four vars are first-class in **both** layers (`monoceros-config.env`
and `<name>.env`), and `ATLASSIAN_API_TOKEN` / `ATLASSIAN_BITBUCKET_TOKEN`
are **two independent tokens** — a single token cannot cover both sides
today (see the resolved gate below). Set only the side(s) you need:

| Use                               | Required vars                                                    |
| --------------------------------- | ---------------------------------------------------------------- |
| Jira / Confluence / Assets / Rovo | `ATLASSIAN_INSTANCE` + `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN` |
| Bitbucket (clone + twg bb)        | `ATLASSIAN_EMAIL` + `ATLASSIAN_BITBUCKET_TOKEN` (no instance)    |
| both                              | all four                                                         |

`instance` is required for the gateway side (Jira/Confluence resolve a
cloudId from it) but not for Bitbucket (git over `bitbucket.org`, workspace
from the repo URL). The two token vars map 1:1 to twg's own `TWG_TOKEN` +
`TWG_BBC_TOKEN`.

**Missing values → warn, do not stop.** Consistent with a missing git
PAT today (`apply/index.ts`, `formatUnauthenticatedRepos`): the container
builds and runs, the CLI just starts unauthenticated. The warning is
**toggle-aware** — it names only the vars the _enabled_ sub-tools need
(forge needs no `instance`; twg does).

### 2. twg is Bitbucket's provider CLI, auto-added like gh/glab

Bitbucket becomes a full git provider, parallel to gh/glab, with twg as
its CLI. Adding a Bitbucket repo **auto-adds the Atlassian feature**,
exactly as a github/gitlab repo auto-adds github-cli/gitlab-cli today
(`init/index.ts`, `modify/index.ts`, driven by the provider component's
`contributes.features`). Bitbucket is currently the **lone provider
excluded** from that auto-add — hardcoded `github|gitlab` filters at
`init/index.ts:233` and `modify/index.ts:495`. The rework gives the
bitbucket provider a `contributes.features` → `atlassian` and lifts the
filter.

Flow:

1. `monoceros add-repo <name> <bitbucket-url>` (or `--with-repos`) —
   clones and auto-adds the atlassian feature
2. the three `ATLASSIAN_*` values resolve from `<name>.env` or global
3. `twg` is an authenticated CLI the in-container AI agents can drive.

No standalone `add-feature` step, same as github/gitlab. There is nothing for
Monoceros to derive or inject for the Bitbucket workspace: twg auto-detects
the workspace and repo from the git remote of the repository the command runs
in (cwd-based, like git itself), so the workspace is never entered by hand.

The auto-add is **twg-only**: it applies the `twg` preset
(`rovodev: false, twg: true, forge: false`), consistent with "twg is the
Bitbucket CLI" — no Rovo/Forge ballast from "I cloned a repo".
github-cli/gitlab-cli are single-purpose, so their auto-add takes plain
defaults; the atlassian feature defaults to all three sub-tools on, so
the repo-driven path must carry the preset. Today the auto-add adds the
ref with default options, so `contributes.features` grows an
options/preset field the auto-add applies. A direct `monoceros
add-feature <name> atlassian` still gives the full default feature.

### 3. Bitbucket leaves the ADR-0031 git cascade — clean break

Bitbucket's clone/push token is the **Atlassian token**, not a
`BITBUCKET_*` var. It resolves from `ATLASSIAN_BITBUCKET_TOKEN` alone (a
distinct Bitbucket-scoped token; see §1), no URL-segment keying — one
scoped token covers every workspace the user can reach. Consequences:

- `BITBUCKET_API_TOKEN` and `GIT_TOKEN__BITBUCKET_*` are **removed**. No
  migration or alias — nobody is known to use the Bitbucket path yet, so
  we take the clean cut over an alias debt.
- The ADR-0031 "every provider, same three var shapes" rule no longer
  covers Bitbucket. That is not an exception bolted on — see (4).
- Host detection, `resolveProvider`, and the
  `x-bitbucket-api-token-auth` username are unchanged. Bitbucket stays a
  "provider" for URL/host/username purposes; only the token **source**
  moves.

### 4. Per-provider token strategy as the extension point

Instead of a special-case branch for Bitbucket, token resolution becomes
a **static, per-provider strategy table** — the third such table beside
`CANONICAL_HOST`, `PROVIDER_TOKEN_VAR`, `GIT_CREDENTIAL_USERNAME`:

```ts
interface ProviderTokenStrategy {
  /** env vars to try for a repo, in order. */
  candidates(url: string): string[];
  /** also inject the resolved token into the contributed CLI feature? */
  injectFeature: boolean;
}
```

- **github / gitlab:** `candidates` = the current 3-tier
  (`<P>_API_TOKEN` → `GIT_TOKEN__<P>_<SEG>` → `GIT_TOKEN__<P>`),
  `injectFeature: true`.
- **bitbucket:** `candidates` = `['ATLASSIAN_BITBUCKET_TOKEN']`,
  `injectFeature: false` (feature-env already authenticates twg). One var,
  one purpose — the Bitbucket-scoped token, always distinct from
  `ATLASSIAN_API_TOKEN` (see the resolved gate below).

`resolveRepoTokens` drives off the table; the `if (provider ===
'bitbucket')` dissolves into a data row. A new provider (Gitea,
self-hosted) is one row, not a change to the loop.

**Guard rails:** a static in-code table, **not** a plugin/registry
loader — git providers are a small closed set, and dynamic loading for
three entries would be over-engineering. The strategy governs **only
token resolution**; host detection, username, and provider mapping stay
their own tables rather than collapsing into one god-object.

### 5. `monoceros-config.yml` retires; everything moves to env

`defaults.features` is one of two global-default paths for feature
options; the global `monoceros-config.env` already provides the other
via `${VAR}` merge. Dropping `defaults.features` is a **simplification**,
not new machinery, and it removes the "secret with two homes" split.

The remaining `monoceros-config.yml` fields need env homes before the
file can go entirely:

- `defaults.git.user` → `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`
  (affects the apply identity-prompt persistence)
- `routing.hostPort` (ADR 0007) → `MONOCEROS_HOST_PORT`
- `upgrade.staleDays` (ADR 0018) → `MONOCEROS_UPGRADE_STALE_DAYS`

The auth rework (1-4) is what #36 ships. The routing/upgrade/git-identity
migration is the mechanical remainder of "kill the yml" and is staged
after, since it touches `proxy/*`, the upgrade check, and the identity
flow rather than the token model.

### Use cases — all four covered by two env layers

A container always runs against exactly one Atlassian context, so every
use case reduces to "set the one triple this container uses." The global
`monoceros-config.env` is the convenience default for the common case;
`<name>.env` overrides it for anything else.

| #   | shape                               | how                                                       |
| --- | ----------------------------------- | --------------------------------------------------------- |
| 1   | one account, one instance           | all three `ATLASSIAN_*` global; zero per-container config |
| 2   | one account, several instances      | mail+token global, `ATLASSIAN_INSTANCE` per `<name>.env`  |
| 3   | several accounts, one instance each | full triple per `<name>.env` (one account per container)  |
| 4   | several accounts, several instances | full triple per `<name>.env`                              |

No keyed/alias tier is needed. It would only earn its keep for **two
accounts active simultaneously in one container**, which cannot happen
(one `TWG_SITE`, one token per container). The per-container env is the
whole answer.

## Consequences

- The Atlassian secret has **one home** (env), consistent with git
  tokens — it is no longer documented under `defaults.features`.
- Bitbucket is a full provider with twg as its CLI; in-container agents
  get authenticated Bitbucket access from the same token that clones.
- One provider special-case is replaced by a clean extension point; ADR
  0031's cascade rule is restated as "each provider declares a token
  strategy" rather than carrying a Bitbucket exception.
- **Breaking:** `BITBUCKET_API_TOKEN` / `GIT_TOKEN__BITBUCKET_*` no
  longer resolve. Accepted — no known users.
- `monoceros-config.yml` is on the way out; this ADR steers Atlassian
  off it, the rest (the `defaults.features` mechanism, `routing`,
  `upgrade`, `git.user`) is staged with the yml-retirement follow-up.

## Implementation status

Shipped in the first pass (CLI 1.40.0, atlassian feature 1.2.2):

- **Per-provider token strategy** (`apply/repo-token.ts`): the
  `PROVIDER_TOKEN_STRATEGY` table drives resolution; bitbucket resolves
  `ATLASSIAN_BITBUCKET_TOKEN` with `injectFeature: false`, github/gitlab
  keep the cascade. `BITBUCKET_*` removed.
- **Bitbucket auto-adds `atlassian/twg`** via the shared
  `PROVIDER_FEATURE_SELECTOR` map (`config/schema.ts`), used by both
  `init` and `add-repo`. Verified end-to-end: an init with a bitbucket
  repo emits the atlassian feature with `rovodev/forge: false` and seeds
  the `ATLASSIAN_*` env keys (present, blank).
- **Feature descriptor**: `bitbucketToken` description corrected (no
  longer "app password").
- **Samples**: `ATLASSIAN_*` documented in `monoceros-config.sample.env`;
  the atlassian block removed from `defaults.features` in the sample yml.
- **Warnings**: the bitbucket-repo missing-token case warns via
  `formatUnauthenticatedRepos`; a declared repo that did not check out
  (token present but under-scoped, network, …) warns via the sibling
  `formatFailedClones` (detected post-up by the absent `projects/<path>`),
  so the summary no longer implies a failed clone succeeded.
- **twg install resilience**: dropped the removed `--global` flag from
  `twg skills install` (twg 1.1.0) and made the skills-install step
  best-effort so a future twg CLI drift warns instead of failing
  post-create (see the twg-drift canary issue).

Deferred / undecided:

- **Toggle-aware feature-cred warning** for the atlassian feature present
  _without_ a bitbucket repo and with empty creds. Not a regression (that
  case was silent before); a follow-up.
- **yml-retirement**: removing the `defaults.features` mechanism and
  moving `routing`/`upgrade`/`git.user` to env.

## Resolved: two tokens (classic for the apps, scoped for Bitbucket)

Settled by real-account testing (2026-07-23):

- A **classic (unscoped) API token** covers Jira / Confluence / Assets /
  Rovo / Forge — but **not** Bitbucket. (An earlier apparent 401 from a
  classic token was a transient glitch, not the rule.)
- A **Bitbucket-scoped token** (`read/write:repository:bitbucket`) covers
  Bitbucket — clone and twg's Bitbucket commands.
- **No single token covers both today.** A legacy token spanning many
  products (Bitbucket + Confluence + Jira + …) still works, but such
  multi-product tokens **can no longer be created** — the scoped-token
  creation UI is single-select (one app per token). A true cross-product
  single credential exists only via OAuth 2.0 (3LO), which is not the
  personal-API-token model.

So `ATLASSIAN_API_TOKEN` (classic, apps) and `ATLASSIAN_BITBUCKET_TOKEN`
(scoped, Bitbucket) are **two independent tokens**, both creatable today —
no dead end for new users, and no `=${…}` shared default. `instance` is
required for the apps side, not for Bitbucket-only.

Watch item (not blocking): classic tokens are on Atlassian's deprecation
path. When they are retired, the apps side loses its single-token option;
the deferred **OAuth-login fallback** becomes the answer then — analyzed
feasible (`docker exec -it <container> twg login` in a PTY; twg documents
the "run in a PTY, delegate browser approval to the user" pattern; auth
persists via the feature's `.config/twg` mount). A support request to
Atlassian about multi-product token creation is open.
