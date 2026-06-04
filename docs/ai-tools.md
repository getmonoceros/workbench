# AI Tools in Monoceros

Monoceros brings AI coding tools (Claude Code, Rovo Dev, GitHub
Copilot, etc.) into the container as **devcontainer features**. One
feature per tool, bundling install + auth + persistence.

This document summarizes:

- which AI tool features are live today
- how the **container briefing** (`AGENTS.md` / `CLAUDE.md` /
  `.monoceros/commands.md`) tells the AI tools running in the
  container what is actually available
- what is planned to follow in the same pattern
- how to build a new tool feature

The conceptual framing (why features, why the yml model) lives in
[concept.md](./concept.md). The state-model background (why each
container has its own `home/`) is in
[ADR 0003](./adr/0003-container-state-model.md).

## Live today

| Feature       | Tool                                       | Auth mechanism                                                                      |
| ------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `claude-code` | Anthropic Claude Code CLI                  | Subscription/OAuth via `claude` interactive, OR `apiKey` for ANTHROPIC_API_KEY mode |
| `atlassian`   | Atlassian stack: Rovo Dev (`acli`) + `twg` | `apiToken` for non-interactive login on both sub-tools                              |
| `github-cli`  | GitHub CLI (`gh`)                          | `apiToken` as `GH_TOKEN` for transparent auth                                       |

All three use the same pattern:

1. **Feature install** pulls the tool into the container image
   (npm/apt/curl depending on the tool).
2. **Persistent home subpaths** (`~/.claude`, `~/.config/acli`,
   `~/.rovodev`, `~/.config/gh`, `~/.agents`) are declared via
   `x-monoceros.persistentHomePaths` and bind-mounted from
   `<container-dir>/home/<subpath>`. Logins, session history, and
   skills survive every `monoceros apply`.
3. **Auth options** come either per container in the yml
   (`features[].options.apiToken: …`) or globally, once, in
   `monoceros-config.yml` under
   `defaults.features.<ref>.<option>`. Per-container wins on the
   merge.
4. **Post-create hook** does the actual login. Idempotent for tools
   we control; on token rotation in the yml, the change propagates
   automatically on the next apply.

## Auth tokens in plaintext: what happens to them?

- **During the build**, tokens are passed through to `docker build`
  as build args via feature options. The build output runs through
  our [secret masker](../packages/cli/src/util/mask-secrets.ts),
  which renders known token shapes (`ATATT…`, `ghp_…`, `sk-ant-…`,
  …) as prefix + last 6 characters. The token stays identifiable but
  not readable.
- **On disk**, tokens live in plaintext in the container yml and
  possibly in `monoceros-config.yml`. These files are deliberately
  kept out of Git (`.gitignored` by default). If you want to harden
  secrets further: optional `env:` indirection or a secret-manager
  hook may come later (see backlog → "Planned for later").

## Container briefing — `AGENTS.md` / `CLAUDE.md`

An AI tool running in the container does not know out of the box what
stack was materialized here. A Java workbench risks Claude proposing
a Node backend — simply because Claude doesn't know there's no Node.
On `apply`, Monoceros therefore writes three files to the container
workspace root that handle the briefing.

### What gets written

```
<container-dir>/
├── AGENTS.md               ← stack briefing + behavior rules
├── CLAUDE.md               ← @AGENTS.md (import stub)
└── .monoceros/
    └── commands.md         ← complete CLI reference
```

- **`AGENTS.md`** — the actual briefing content. It describes:
  - which languages, services, tools, repos, and ports are in the
    container (derived from the yml);
  - the Monoceros model itself (declarative, container-isolated,
    host extension via `monoceros add-*` + `apply`);
  - how the AI tool should react to missing capabilities (propose
    the matching host command as a copy-pasteable code block).
- **`CLAUDE.md`** — the `@AGENTS.md` import between markers. Claude
  Code's documented mechanism for AGENTS.md coexistence. OpenCode
  reads both files directly and would work without this stub. The
  file carries markers so that Claude-Code-specific rules below it
  (which would make no sense in the multi-tool `AGENTS.md`) are not
  lost on re-apply — see "User notes survive re-apply" below.
- **`.monoceros/commands.md`** — auto-generated from the citty defs in
  `packages/cli/src/commands/*.ts`. One H3 per subcommand with
  signature, arguments, and flags. `AGENTS.md` imports it via
  `@.monoceros/commands.md` — so the AI tool can look up the exact
  command syntax before making a suggestion.

### How the briefing reaches the AI tool

The files live **one level above** the projects. Claude Code,
OpenCode, and other tools that walk hierarchically upward from their
cwd find them automatically — no matter which `projects/<repo>/` the
session was started from.

> **On the first Claude start in a project:** Claude shows an
> approval dialog "Allow external CLAUDE.md file imports?" — because
> `AGENTS.md` and `.monoceros/commands.md` live outside the project
> directory. **Accepting is safe and necessary**: the files are
> Monoceros-generated, not from third parties. Declining is
> **permanent** for this project (no re-prompt) — the briefing then
> stays invisible.
>
> Approve once per project. With three projects under `projects/`,
> that means three one-time prompts.

Codex (bounded by git-root downward), Gemini CLI ("trusted root",
still unresolved), and GitHub Copilot (workspace-root only, buggy in
multi-root) do **not** see the briefing **today** — they are
deliberately deferred.

### User notes survive re-apply

`AGENTS.md` is surrounded by HTML-comment markers:

```markdown
<!-- monoceros:begin -->

… Monoceros-generated content …

<!-- monoceros:end -->

## My own notes

(Anything outside the markers is yours. Apply preserves it.)
```

Every `monoceros apply` replaces **only** the content between the
markers. Whatever you write outside (your own coding standards,
project-specific reminders) is preserved. This applies to **both
`AGENTS.md` and `CLAUDE.md`** — both carry markers. Cross-tool
content belongs in `AGENTS.md`; only strictly Claude-Code-specific
things (that other tools won't interpret) belong in `CLAUDE.md`.

`.monoceros/commands.md` is 100% Monoceros-owned and is always
rewritten in full — not a place for user notes.

All three files are in the container-root `.gitignore` — so if
`git init` ever runs there, they don't end up in the repo.

### No credentials in the briefing

The file deliberately contains **no** service credentials, neither
dev defaults from the catalog nor values from the `.env`. The
briefing instructs the AI tool to ask the user during the running
session when it needs credentials, and not to write them into
versioned material.

Background: `AGENTS.md` is treated as local-only like the `.env` and
is gitignored — but it's an additional surface (screenshot, paste,
share with other AI tools). The "no credentials" line keeps that
surface low-risk.

### Manifest-driven feature briefings

Each feature can declare, in its own `devcontainer-feature.json`,
which lines it contributes to the "Installed tools" section of
`AGENTS.md`. Conditions are allowed:

```json
"x-monoceros": {
  "briefing": {
    "lines": [
      {
        "whenOption": "rovodev",
        "text": "Atlassian Rovo Dev — invoke via `acli rovodev`. Pre-authenticated against the Atlassian account in the feature options."
      },
      {
        "whenOption": "twg",
        "text": "Atlassian Teamwork Graph CLI (`twg`) — Jira / Confluence / Bitbucket / JSM / Assets access."
      }
    ]
  }
}
```

- **`text`** — the bullet content (without the leading `- `).
  Markdown and inline code are allowed.
- **`whenOption`** — optional. When set, the line is only emitted if
  the named feature option is **truthy** at apply time (boolean
  `true`, non-empty string, number ≠ 0). Without `whenOption`, the
  line is unconditional.
- Defaults are pulled from the feature manifest options; user values
  in the container yml win.

Consequences:

- A feature with two sub-tools (e.g. `atlassian` with `rovodev` +
  `twg`) has two lines, one per sub-tool. Disable one
  (`twg: false`) and only that line disappears.
- If a feature declares a `briefing` block but **no** line matches
  (all `whenOption` are falsy), the feature is **silently omitted** —
  no "tool installed" when none is running.
- Without `x-monoceros.briefing`, the generator falls back to the
  `displayName` from the component catalog
  (`packages/cli/templates/components/<name>.yml`), or for
  third-party features to the last path-segment name of the OCI ref.

### Background

Design decision and trade-offs:
[ADR 0014 — AI tool briefing in the container workspace root](./adr/0014-ai-tool-briefing-im-workspace-root.md).
The implementation lives under `packages/cli/src/briefing/`.

## What's planned to follow

Planned:

- **OpenCode** — sst's open-source multi-model CLI
- **Codex** — OpenAI Codex CLI
- **GitHub Copilot CLI** — `gh extension install github/gh-copilot`
- **Aider** — Python-based pair-programming CLI

Each is built in the same pattern as `claude-code`: install via
package manager → `persistentHomePaths` for the auth dir → optional
`optionHints` in the manifest for the UX auth display in the `init`
output.

## How does a new tool feature get added?

A recipe, using a fictional tool `foo` as the example:

### 1. Feature directory

```
images/features/foo/
├── devcontainer-feature.json
└── install.sh
```

### 2. `devcontainer-feature.json`

```json
{
  "$schema": "https://raw.githubusercontent.com/devcontainers/spec/main/schemas/devContainerFeature.schema.json",
  "id": "foo",
  "name": "Foo CLI",
  "version": "0.1.0",
  "description": "Installs the Foo CLI. Auth via apiKey or interactive `foo auth login`.",
  "options": {
    "apiKey": {
      "type": "string",
      "default": "",
      "description": "Foo API key. Exported as FOO_API_KEY when set."
    }
  },
  "customizations": {
    "vscode": { "extensions": ["foo.vscode-foo"] }
  },
  "x-monoceros": {
    "persistentHomePaths": [".config/foo"],
    "optionHints": ["apiKey"],
    "briefing": {
      "lines": [
        {
          "text": "Foo CLI (`foo`) — invoke directly. Pre-authenticated when `apiKey` was set; otherwise needs `foo auth login` once."
        }
      ]
    }
  }
}
```

Important:

- `x-monoceros.persistentHomePaths` — which subdirs under
  `/home/node/` the container lifecycle must keep persistent.
- `x-monoceros.optionHints` — which options should appear as
  commented hint lines under the `options:` block in the generated
  yml. By default, the auth-relevant ones.
- `x-monoceros.briefing.lines` — the bullets that appear in
  `AGENTS.md` under "Installed tools". One line for a simple tool;
  multiple with `whenOption` gating when the feature toggles several
  sub-tools on/off via boolean options (see
  [container briefing](#container-briefing--agentsmd--claudemd)
  above).

### 3. `install.sh`

Runs as root in the container during `docker build`. Downloads the
tool, validates the install, and optionally drops a post-create hook
at `/usr/local/share/monoceros/post-create.d/foo.sh` — which
Monoceros' generated `post-create.sh` calls on container start, with
the bind mounts under `/home/node/` already active.

### 4. Component entry

Optional but recommended — so that
`monoceros init … --with-features=foo` works (and the short name
shows up in `list-components`):

```
templates/components/foo.yml
```

```yaml
displayName: Foo CLI
description: |
  Installs Foo CLI via apt. Auth via apiKey or interactive
  `foo auth login` on first use; state persists in ~/.config/foo.
category: feature
contributes:
  features:
    - ref: ghcr.io/getmonoceros/monoceros-features/foo:1
```

### 5. Docs

Add an entry to the "Live today" table in this file, plus a short
description if the feature has special behavior (e.g. how `atlassian`
bundles Rovo Dev + twg into a single feature).

## Related documents

- [concept.md](./concept.md) — the framing
- [adr/0003-container-state-model.md](./adr/0003-container-state-model.md)
  — why each container has its own `home/`
- [commands/init.md](./commands/init.md) — `--with-*` flags and
  version suffix
- [commands/apply.md](./commands/apply.md) — what happens on apply
- [images/features/README.md](../images/features/README.md) —
  workbench-internal conventions for feature authors
