# ADR 0016 — Enrich the Generated `.code-workspace`

- Status: accepted
- Date: 2026-06-05

## Context

`buildCodeWorkspaceJson` (in `create/scaffold.ts`) today emits only a
`folders` array: `{ path: "." }` first, then one entry per repo under
`projects/<path>`. Three things follow from that minimalism:

- The `.` root has **no `name`**, so VS Code labels it with the
  container directory's basename. When a repo is named like the
  container, the Explorer shows two identical labels (observed in the
  field: two `logoscraper` roots, one the workspace root, one the repo).
- The `.` root surfaces the **whole scaffold** — `.devcontainer/`,
  `.monoceros/`, `home/`, `data/`, `projects/`, the `.code-workspace`
  itself — most of which is noise to the builder.
- `mergeCodeWorkspace` favours the builder: it preserves their
  `folders[]` and appends generator-only folders; every other top-level
  key passes through verbatim. The generator has **never** written
  `settings` or `extensions`.

Two extension channels exist, and they must not be conflated:

- `devcontainer.json` / feature manifest
  (`customizations.vscode.extensions`) → **auto-install**, survives a
  rebuild. Our features already use it (claude-code →
  `anthropic.claude-code`, atlassian → `Atlassian.atlascode`, github-cli
  → `github.vscode-pull-request-github`).
- `.code-workspace` → `extensions.recommendations` → a **soft prompt**,
  installs nothing on its own.

## Decision

Make the generated `.code-workspace` a richer artifact along three axes.

**1. Generic, stable root identity.** The first root gets
`name: "🦄 Monoceros"` — identical in every container. (Monoceros is the
unicorn constellation; the mark also disambiguates the workspace root
from a same-named repo root.)

**2. Denoise the root.** In the `.` root, show only `home/`, `logs/`,
`AGENTS.md`, and `CLAUDE.md`; hide the rest of the scaffold. The
mechanism is a **per-root `<container-root>/.vscode/settings.json`**
with a `files.exclude` block — **not** a workspace-wide `files.exclude`
in the `.code-workspace`. A workspace-wide exclude would apply its
patterns to every root, including the project repos: a cloned repo's own
`.gitignore` or `data/` directory would be hidden too, which is actively
wrong. A folder-level `.vscode/settings.json` scopes the exclude to the
Monoceros root alone and leaves the project roots untouched.

**3. Context-derived extension recommendations**, governed by one
principle:

> **Certainty → auto-install. Inference → recommend.**

- **Feature-bound** (the feature _is_ the tool): auto-install via the
  feature manifest, unchanged.
- **Context-derived** ("you have X, you might want Y"): a recommendation
  only, written to `extensions.recommendations`.
- **Mappings:** curated services carry an optional `vscodeExtensions`
  field in `SERVICE_CATALOG`; a small host→extension table maps
  github/gitlab/bitbucket (derived from `repo.url`) to that host's main
  extension; features need no duplication (already auto-installed).
- **Verified IDs** (checked against the marketplace, not written from
  memory):

  | Trigger                                     | Extension ID                                                                 |
  | ------------------------------------------- | ---------------------------------------------------------------------------- |
  | any DB service (`postgres`/`mysql`/`redis`) | `cweijan.vscode-database-client2`                                            |
  | repo @ github.com                           | `github.vscode-pull-request-github`, `GitHub.vscode-github-actions`          |
  | repo @ gitlab.com                           | `GitLab.gitlab-workflow`                                                     |
  | repo @ bitbucket.org                        | none — `Atlassian.atlascode` already auto-installed by the atlassian feature |

  One unified DB client (`cweijan.vscode-database-client2`) covers all
  three curated DB engines, so the three services map to the same ID;
  the merge dedup means it appears once even when several DBs are
  present.

- **Assembly point:** `buildCodeWorkspaceJson`, from `opts.services` and
  `opts.repos` — **not** `add-repo` (it only writes the URL to the yml)
  and **not** `post-create` (it runs inside the container;
  recommendations are a host-side artifact).

**4. Merge rule for recommendations.** `recommendations =`
union(builder's, generated), deduplicated, never auto-removed. The
builder's escape hatch is `unwantedRecommendations` — listing an entry
there suppresses the prompt. `mergeCodeWorkspace` gains this rule
alongside its existing `folders` rule.

## Rationale

- The root label is the first thing a builder sees; the duplicate-label
  effect reads as a bug. A generic, branded name fixes it at near-zero
  risk.
- Recommendations (soft) respect the workbench stance — "frame the
  build, don't dictate its contents." An inference is a guess, and a
  guess belongs in a prompt the builder can dismiss, not in a forced
  auto-install.
- This finally gives the `.code-workspace` `extensions` block a
  justified purpose without duplicating what features already
  auto-install.

## Consequences

- `buildCodeWorkspaceJson` grows service-/repo-derived recommendation
  logic; `SERVICE_CATALOG` gains an optional `vscodeExtensions` field; a
  host→extension table is added.
- `mergeCodeWorkspace` manages a second key
  (`extensions.recommendations`) under the same favour-builder spirit it
  applies to `folders`.
- **Exact marketplace extension IDs are verified against the marketplace
  at implementation time, not written from memory.** Only the IDs our
  features already use are pre-known
  (`github.vscode-pull-request-github`, `Atlassian.atlascode`).
- GitHub Actions / "only if the repo uses it" cannot be known at
  generate time. We recommend the host's main extension and, optionally,
  the Actions extension — a cheap prompt, never an auto-install.

## Rejected

- **Auto-installing context-derived extensions** — intrusive; an
  inference forced into the builder's editor.
- **Recommending GitLens (or any opinionated general-git extension) for
  every repo** — a strong opinion the workbench should not impose.
- **Duplicating feature extensions into `recommendations`** — redundant;
  features already auto-install them.
- **Dropping the `.` root entirely** — breaks the no-repos case (an
  empty workspace) and hides root-level files (`post-create.sh`, the AI
  briefings) the builder may need.

## Open items

- None. (Extension IDs verified; `files.exclude` scoping decided.)
