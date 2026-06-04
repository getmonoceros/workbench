# `monoceros list-components`

Prints the component catalog that
[`monoceros init`](./init.md) understands for its `--with-*` flags.

```sh
monoceros list-components
```

## Purpose

When the builder no longer remembers **which building blocks** exist,
`list-components` is the fastest way to the answer — faster than
`init` without `--with-*` (reading the documented template) and faster
than opening the sources under
[`templates/components/`](../../templates/components/) yourself.

The output is deliberately tab-separated so the list can be piped into
other tools without trouble:

```
# language
dotnet     .NET via devcontainers/features/dotnet:2
go         Go via devcontainers/features/go
java       Java via devcontainers/features/java
node       Node 22 + pnpm
python     Python 3.x via devcontainers/features/python
rust       Rust via devcontainers/features/rust

# service
mysql      MySQL 8 compose service
postgres   PostgreSQL 16 compose service
redis      Redis 7 compose service

# feature
atlassian          Atlassian CLIs (Rovo Dev + Teamwork Graph), both on
atlassian/rovodev  Atlassian Rovo Dev only (via acli rovodev)
atlassian/twg      Atlassian Teamwork Graph CLI only (twg)
claude             Anthropic Claude Code CLI
github             GitHub CLI (gh)
```

The left column is exactly the name that the `monoceros init`
`--with-*` flags expect. Multiple components can be combined comma-separated:

```sh
monoceros init sandbox --with-languages=node --with-services=postgres --with-features=github,claude
```

## Arguments

None — the command always reads the full catalog of the running
workbench.

## Related commands

- [`monoceros init`](./init.md) — compose components into a finished
  yml or generate a documented template
