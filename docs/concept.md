# Monoceros — Concept

What Monoceros is, what it deliberately is not, and how the workbench
is built. If you want to understand what Monoceros is for and how the
pieces fit together, you're in the right place. The concrete commands
live under [`commands/`](./commands/), the architecture decisions
under [`adr/`](./adr/).

## Positioning

> **Monoceros is a workbench for local, reproducible dev containers
> with AI-coding tooling. You declaratively describe what should live
> in the container, and Monoceros materializes it. Language- and
> stack-agnostic. No cloud, no SaaS, no built-in workflow lock-in.**

How it differs from the obvious alternatives:

| Alternative        | What they do differently                | What Monoceros does better                                              |
| ------------------ | --------------------------------------- | ----------------------------------------------------------------------- |
| GitHub Codespaces  | Cloud-only, vendor lock-in, hourly cost | Local, no rental, data stays on your machine                            |
| Cursor Cloud       | Cloud workspace, fixed tooling stack    | Local, tools are the builder's choice                                   |
| Plain devcontainer | Works; you build everything yourself    | Reusable yml profiles, CLI boilerplate, curated AI-tool features        |
| Local dev setup    | Full host access for every tool         | Container isolation: AI tools run in a separate Linux, not on your host |

The things that together make the product:

1. **Declarative yml model** — one file describes the container,
   `monoceros apply` materializes it. Reproducible across machines,
   versionable, diffable.
2. **AI tools are first-class** — Claude Code, OpenCode, Rovo Dev,
   Codex etc. land as devcontainer features in the container, chosen
   by the builder via yml.
3. **Container isolation by default** — everything runs in a Linux
   container, not on your host. A malicious npm package or an AI
   agent cannot reach your `~/.ssh/`, your browser state, or host
   files outside the deliberately mounted workspace.

## The three building blocks

### 1. Workbench runtime image

A local Docker image (currently `monoceros-runtime:dev`, later
published to GHCR), built on
[`mcr.microsoft.com/devcontainers/typescript-node`](https://hub.docker.com/_/microsoft-vscode-devcontainers).
Contents:

- Debian Bookworm + Node 22 + pnpm + corepack
- `gosu` for a clean user switch in the entrypoint
- Standard dev tools from the base image: `git`, `curl`, `ssh`, `jq`,
  `make`

An opt-in egress allowlist mechanism (iptables-based, enabled via
`MONOCEROS_EGRESS=enforce`) still lives in the image for historical
reasons but is disabled in the default workflow — the
hostname-snapshot variant isn't compatible with rotating CDN IPs (VS
Code Marketplace etc.). Details in
[ADR 0002](./adr/0002-egress-whitelist-runtime-image.md). Sandboxing
is **not** an advertised property of Monoceros today beyond normal
container isolation.

**What is not in the image:**

- No AI CLIs preinstalled. Claude Code, OpenCode, Rovo Dev, Codex
  etc. are pulled into the container via devcontainer features, not
  baked into the image.
- No language toolchains other than Node — Python, Java, Go etc. also
  come via features.

This keeps the image lean and language-/tool-neutral. The builder
sees _explicitly_ in the yml what's in the container.

### 2. Declarative yml model

A container config lives at
`$MONOCEROS_HOME/container-configs/<name>.yml`. Schema-validated
(Zod), comment-preservingly editable, with a clear lifecycle:

```yaml
schemaVersion: 1
name: sandbox

languages: [python]
services:
  - name: postgres
    image: postgres:18
    port: 5432
    env: # ${VAR} → from sandbox.env; dev defaults are seeded
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes:
      - data:/var/lib/postgresql
    restart: unless-stopped
    healthcheck:
      test:
        ['CMD', 'pg_isready', '-U', '${POSTGRES_USER}', '-d', '${POSTGRES_DB}']
      interval: 10s
      timeout: 5s
      retries: 5

features:
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
  - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1
    options:
      rovodev: true
      twg: true

repos:
  - url: https://github.com/your-org/api.git
```

`monoceros apply sandbox` materializes this into
`$MONOCEROS_HOME/container/sandbox/` as a full devcontainer. A second
apply after an edit overwrites deterministically.

Container identity follows the convention
`<MONOCEROS_HOME>/container/<name>/`: one config → one container, 1:1.
cwd is irrelevant; every command works from anywhere via
`monoceros <command> <containername>`.

### 3. AI tools as devcontainer features

Each AI tool is a devcontainer feature under
`ghcr.io/getmonoceros/monoceros-features/<tool>:1`. The builder picks
explicitly what's in the container. One consistent mental model:

```yaml
features:
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
  - ref: ghcr.io/getmonoceros/monoceros-features/opencode:1
```

Planned feature catalog:

| Feature       | Tool                                          | Status      |
| ------------- | --------------------------------------------- | ----------- |
| `claude-code` | Anthropic Claude Code CLI                     | first stage |
| `atlassian`   | Atlassian stack — Rovo Dev (`acli`) + TWG CLI | first stage |
| `opencode`    | sst OpenCode (multi-model, OSS)               | later stage |
| `codex`       | OpenAI Codex CLI                              | later stage |
| `gh-copilot`  | GitHub Copilot CLI                            | later stage |
| `aider`       | Aider (Python, OSS)                           | later stage |

**Credentials for AI tools** are stored directly on the feature entry
in the container yml — where the tool is enabled:

```yaml
features:
  - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1
    options:
      email: you@example.com
      apiToken: ATATT3xFf… # site/instance is asked for once by `acli rovodev run`
  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1
    options:
      apiKey: sk-ant-… # optional → API mode instead of OAuth/subscription
```

So the same Atlassian/Anthropic data doesn't have to be repeated in
every container yml, `monoceros-config.yml` holds defaults per feature
ref:

```yaml
defaults:
  features:
    ghcr.io/getmonoceros/monoceros-features/atlassian:1:
      email: you@example.com
      apiToken: ATATT3xFf…
```

`monoceros apply` merges per-container options over the global
defaults — the container yml wins, missing values are filled from the
global block.

**The container explains itself.** So the AI tools know which stack
actually lives in the container (languages, services, feature tools),
`monoceros apply` writes a briefing as `AGENTS.md` with a `CLAUDE.md`
import stub next to the `.code-workspace` file in the container
workspace root. Claude Code's walk-up from the project directory finds
the file automatically — no per-session configuration needed. A Java
workbench tells Claude at startup that it provides Java, not Node.
Details:
[ADR 0014](./adr/0014-ai-tool-briefing-im-workspace-root.md).

### Container state survives apply

Each container has a visible home directory on the host disk at
`$MONOCEROS_HOME/container/<name>/home/`. Features declare via
`x-monoceros.persistentHomePaths` which subfolders should be
persistent (e.g. `.claude`, `.config/acli`). On apply this is written
as a bind mount into `devcontainer.json`, so login, session history
and tool-specific state survive across `monoceros apply`. Details:
[ADR 0003](adr/0003-container-state-model.md).

## CLI shape

Every command follows a uniform schema:

```sh
monoceros <command> <containername> [<args> …]
```

Three families:

```sh
# config + lifecycle
monoceros init <name> [--with-languages=… --with-features=… --with-services=… …]  # compose a yml (or a documented template)
monoceros list-components                  # show the component catalog
monoceros apply <name>                     # materialize + bring the container up
monoceros start|stop|status <name>         # compose lifecycle
monoceros shell <name>                     # interactive bash
monoceros run <name> -- <cmd>              # one-off command
monoceros logs <name> [<service>]          # tail
monoceros remove <name>                    # tear the container down completely (backup on by default)
monoceros restore <backup-path>            # restore a container from a backup

# edit config (yml AST mutation, comment-preserving)
monoceros add-language|service|apt-packages|feature|from-url|repo <name> …
monoceros remove-… <name> …
```

cwd is irrelevant — everything works via convention.

## Code layout of the workbench

The workbench is a single package:

```
monoceros-workbench/
├── packages/
│   └── cli/                # the only code component
├── images/
│   └── runtime/            # Dockerfile for the workbench image
├── templates/
│   └── components/         # component catalog for `monoceros init --with-*`
└── docs/
```

## What deliberately does not belong in the product

- **Cloud hosting / SaaS variant** — against the principle "your
  Docker, your data, no rental"
- **Own web UI** — the CLI is the UI, the container workspace is the
  working environment
- **Built-in iteration workflow** — `monoceros iterate` etc. are out,
  because it was unclear whether/how they add value over Claude
  Code's own mechanisms
- **Multi-user / shared state** — every builder has their own
  container configs under `$MONOCEROS_HOME`. Synchronization is a
  matter of git repos and team conventions, not of Monoceros
- **Fixed stack templates** (`vite-react-pg`, etc.) — the templates
  stay minimal; what's in the container is assembled by the builder
  via `add-*` commands or hand edits
- **Own auth infrastructure** — a bind mount of `~/.claude/` plus
  optional `monoceros-config.yml` defaults are enough

```

```
