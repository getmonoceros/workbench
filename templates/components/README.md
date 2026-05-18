# Monoceros Components Catalog

Every file under this directory is a **component** — a small,
composable yaml snippet that contributes to a `SolutionConfig`. The
`monoceros init` command picks components by name (via `--with=…`
or by rendering them all as commented-out hints in the documented
default) and merges them into the user's container-config yml.

## File layout

- `<name>.yml` — a top-level component (e.g. `node.yml`, `postgres.yml`).
- `<group>/<name>.yml` — a sub-component of a parent feature
  (e.g. `atlassian/twg.yml` is a sub-component of `atlassian/`).

Component names map 1:1 to their `--with=…` identifier:

- `--with=node` → `node.yml`
- `--with=atlassian/twg` → `atlassian/twg.yml`

## File schema

```yaml
# Short label shown next to the active line (or "- node" entry) in
# the generated yml.
displayName: Node 22 + pnpm

# Longer block, shown as a comment above the section in documented
# mode (i.e. `monoceros init <name>` with no --with). English, free
# prose, can mention what it adds, where credentials come from, etc.
description: |
  Node 22 + pnpm are already in the base image; this component
  declares the runtime as active so the scaffold wires it up.

# Which top-level yml section this component contributes to. Drives
# how the documented-mode renderer groups components.
category: language | service | feature

# The actual yml fragment merged into the final SolutionConfig.
# Must be a valid fragment for the declared category:
#   - language → contributes.languages must be a non-empty string array
#   - service  → contributes.services must be a non-empty string array
#   - feature  → contributes.features must hold one feature entry
contributes:
  # …
```

## Conventions

- **Comments and prose are English**, even though the broader user
  docs are German. The rendered yml is a tool output and English
  reads more cleanly for the typical dev-yml shape.
- **Sub-components set their flag to `true` AND every sibling flag
  to `false`.** Both `atlassian/twg.yml` and `atlassian/rovodev.yml`
  set both `rovodev` and `twg`, just with opposite truth values.
  The init merge applies OR-semantics on booleans: when two
  components contribute the same boolean key, `true` wins. That
  way `--with=atlassian/twg` on its own opts out of the other
  tool, while `--with=atlassian/twg,atlassian/rovodev` merges to
  both `true`. Without the explicit `false`, the manifest defaults
  (`true` for both) would silently re-enable the unwanted tool.
- **Auth/credential options live with the feature, not the
  component.** Each feature manifest under `images/features/`
  declares an `x-monoceros.optionHints` array that the init
  generator uses to render commented-out auth options beneath the
  active options block whenever the feature is included.

## Adding a new component

1. Decide the name and (if it's a sub-component) the group folder.
2. Drop the yml file in. Use an existing component of the same
   category as a starting point.
3. If the component activates a Monoceros feature, make sure that
   feature's manifest under `images/features/<feature>/` carries
   the right `x-monoceros.optionHints` for auth.
4. Add a short note in this README's "Current components" table if
   you want it discoverable at a glance.

## Current components

| Component           | Category | Contributes                                             |
| ------------------- | -------- | ------------------------------------------------------- |
| `node`              | language | Node runtime (declared; package already in base image)  |
| `python`            | language | Python via devcontainer feature                         |
| `postgres`          | service  | Compose service: Postgres                               |
| `mysql`             | service  | Compose service: MySQL                                  |
| `redis`             | service  | Compose service: Redis                                  |
| `claude`            | feature  | `claude-code` feature (Claude Code CLI)                 |
| `github`            | feature  | `github-cli` feature (`gh`) with auto-auth via apiToken |
| `atlassian`         | feature  | atlassian feature: Rovo Dev + twg both on               |
| `atlassian/rovodev` | feature  | atlassian feature with just `rovodev: true`             |
| `atlassian/twg`     | feature  | atlassian feature with just `twg: true`                 |
