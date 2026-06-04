# `monoceros remove-repo`

The inverse of [`add-repo`](./add-repo.md). Removes a repo entry from
the container config.

## Synopsis

```sh
monoceros remove-repo <containername> <url-or-name> [--yes]
```

The `<url-or-name>` argument matches either:

- the full URL of the entry (`git@github.com:foo/bar.git`,
  `https://github.com/foo/bar.git`), or
- the effective folder name under `projects/` (`bar`, or the explicit
  `--as=<…>` from the yml).

## Mechanics

The corresponding array entry in `repos:` is removed from the yml. If
no repos remain after removal, the next apply also removes the Git auth
mounts (SSH agent forwarding, HTTPS credential fetch) from the
devcontainer.

**Important — the existing `projects/<folder>/` directory is NOT
deleted.** Local edits should not be lost to a `remove-repo`. Cleanup
is manual:

```sh
monoceros remove-repo sandbox bar --yes
monoceros apply sandbox
rm -rf $MONOCEROS_HOME/container/sandbox/projects/bar   # manually, when no longer needed
```

## Idempotency

URL/name not in the list → no change.

## Related commands

- `monoceros add-repo` — the inverse
- `monoceros apply <name>` — materialization
