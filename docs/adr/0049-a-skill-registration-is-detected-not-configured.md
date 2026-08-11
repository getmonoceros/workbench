# ADR 0049: An agent-side skill registration is detected, not configured

- Status: accepted, amended 2026-08-11 (see [Amendment](#amendment-2026-08-11-the-rule-needs-a-hook-not-a-sentence))
- Date: 2026-08-09
- Relates to: [ADR 0019](0019-component-taxonomy-service-feature-dependency.md)
  (what becomes a component at all),
  [ADR 0018](0018-tool-freshness-model.md) (why agent-facing state is written at
  apply instead of baked into a cached layer),
  [ADR 0045](0045-mcp-servers-as-catalog-components.md) (one canonical
  definition, translated for every agent that is actually present)

## Context

[graphify](https://github.com/Graphify-Labs/graphify) turns a repository into a
queryable knowledge graph and registers itself as a skill with about twenty AI
coding assistants. It is a feature under
[ADR 0019](0019-component-taxonomy-service-feature-dependency.md) without much
argument: a globally installed CLI, useful across projects, pulled from no
project manifest. What needed deciding is not whether it belongs, but **who
decides which assistants it registers with, and where that registration lands**.

The obvious move is a `platforms` option in the yml, a list the builder keeps in
step with the agents they installed. Two things argue against it. It is a second
copy of information the yml already carries in `features:`, so it can disagree
with reality, and disagreeing silently is its normal failure mode: a skill
registered for an agent that is not there looks exactly like a skill that
registered fine. And it is not how the workbench already answers this question.
The atlassian feature's twg hook detects `claude` and `opencode` with
`command -v` and passes the matching flags, and MCP connectors are translated
into the config of each agent present rather than each agent named
([ADR 0045](0045-mcp-servers-as-catalog-components.md)).

Scope is the second question. graphify installs either globally, into the
agent's home directory, or with `--project`, into the repository the builder is
working in. Upstream's `--strict` mode only exists in project scope: it writes
Claude Code `PreToolUse` hooks into `.claude/settings.json`, and the first raw
file read of a session is answered with `permissionDecision: deny` and a pointer
to run `graphify query` first. Useful, and measured to fire at most once per
session so it cannot strand an agent. But offering it from the yml would mean
the workbench writes into the builder's repository on their behalf.

## Decision

**The registration is detected inside the container, in a post-create hook, and
it is global.**

`install.sh` installs the tool and writes a hook into
`/usr/local/share/monoceros/post-create.d/`. The hook probes for each agent with
`command -v` and calls `graphify install --platform <p>` once per hit, because
the command takes one platform per call and rejects a second value. **No
`platforms` option exists**, and the empty case is not an edge case: a container
with no AI agent gets the CLI and no registration, which is the builder working
from a shell.

The hook, not `install.sh`, because the skill lands in `~/.claude` and
`~/.config/opencode`, and those are bind-mounted at container start: a
build-time write is shadowed by the mount on the first run, the same reason
agent config is written at apply ([ADR 0018](0018-tool-freshness-model.md)). It
re-runs on every container start, which also keeps the skill in step with a tool
that upgraded underneath it.

Global scope, so nothing appears in the builder's git status. Persistence rides
the agent feature that owns the home path, the same coupling Claude Code's chat
history has. **`--strict` is not offered as an option.** A builder who wants it
runs `graphify install --project --strict` themselves, in their repository, as
their own commit.

## Consequences

- **A registration failure must not fail the apply.** devcontainer's postCreate
  skips every remaining hook on a non-zero exit, other features' included, so
  the container would come up half built over a skill file. The hook warns and
  carries on. This is the same rule the twg hook already follows, and the
  reason the feature is honest in `monoceros check` terms: the CLI works even
  when the skill did not register.
- **The hook stands in `$HOME`, and that is load-bearing.** A "global"
  `--platform opencode` install also writes `.opencode/plugins/graphify.js` and
  `.opencode/opencode.json` into the _current directory_, unconditionally and
  without `--project`. From the workspace that would litter the builder's tree;
  from `$HOME` it is inert, because opencode reads `~/.config/opencode`.
- **Global scope means no nudge hooks.** graphify's `PreToolUse` hooks, soft or
  strict, are project-scoped only, so the default container has the skill and
  the `~/.claude/CLAUDE.md` pointer and nothing that intercepts a read. The job
  of telling the agent to ask the graph before grepping falls to the briefing
  line, which is where it belongs anyway
  ([ADR 0039](0039-briefing-shape-rules-first.md)).
- **No API key, and the briefing has to say so.** Code is extracted locally with
  tree-sitter and needs no model. For docs, PDFs and images the running agent is
  the model, and graphify reads no `ANTHROPIC_API_KEY` at all. Only a standalone
  CLI run needs `--code-only` or a Gemini key, and a run without either fails on
  a single README. Without that line in the briefing an agent will ask the
  builder for a key it never needed.
- **The MCP server stays out.** graphify ships one behind its `mcp` extra, and
  everything it exposes is reachable through the CLI this feature installs, in a
  container where the agent has a shell and `graph.json` next to it. Its real
  advantage is `--transport http` for a team pointing at one shared graph
  process, which is the opposite of one local machine. The second entry point
  (`graphify-mcp`) is therefore not put on PATH.
- **The guard against upstream drift is a canary, not a version pin.** graphify
  is pre-1.0 and ships every few days, and features install `latest` by design.
  What the feature sits on is exactly the moving surface: the `install` flags
  and the `graphify-out/` layout. An e2e scenario builds a graph over a small
  fixture with `--code-only` and asserts `graph.json` plus one `graphify query`,
  because `graph.html` and `GRAPH_REPORT.md` take a second `cluster-only` run
  and are not produced by the build alone. If that canary turns into recurring
  maintenance, dropping the feature is the honest outcome.

## Amendment 2026-08-11: the rule needs a hook, not a sentence

Two of the consequences above were wrong, and three runs on the same repository
showed it. Same question, same 15,617-node graph over a 938-file Go backend:
the first answered entirely out of the graph without opening a file, the second
made two queries and then read 926 lines of source, the third made one query and
went off on twenty greps. The spread comes from the model, and no wording in a
briefing line closed it. Two attempts at that wording are in the history of this
feature; both were mine, and both were the wrong instrument.

What the second look also turned up: graphify already ships the rules we were
hand-writing. `always_on/claude-md.md` in its own package says to run
`graphify query` first for codebase questions, to use `path` and `explain`, to
read `GRAPH_REPORT.md` only for a broad review, and to run `graphify update .`
after changing code. That block is written by `claude_install()`, which is the
**project** path. The global path writes `_skill_registration()`, three lines
that say "when the user types `/graphify`, use the skill". So the decision above
shipped the trigger and left out every rule for using it, and nobody noticed
because the first run happened to behave.

**So Monoceros writes the `PreToolUse` hooks itself, into the container's global
`~/.claude/settings.json`** (`create/claude-settings.ts`, at apply, merged like
`permissions.defaultMode` next to it). Matchers `Bash|Grep` and `Read|Glob`,
commands `graphify hook-guard search` and `graphify hook-guard read`, which is
what `graphify install --project` would have put into a repo.

This does not reopen the objection that kept `--strict` out. That objection was
about writing into the builder's repository, and the container's home directory
is not their repository. The hook command is scope-agnostic by construction: it
keys off `graphify-out/graph.json` in the working directory, prints nothing when
there is no graph, and always exits 0, so it is inert in a workspace where
nothing was ever built.

**And `strict` becomes a real option** (`strict: false` by default), for the same
reason: upstream ties strict mode to a project install only because that is
where it puts its hooks. With the hook in the container, the mode is one env var
(`GRAPHIFY_HOOK_STRICT`), delivered through `workspaceEnv`. It denies the first
raw read of a session once, then falls back to the reminder, so it cannot strand
an agent.

What still holds from the original decision: the skill registration is detected
rather than configured, it is global, and nothing Monoceros does lands in the
builder's git status.
