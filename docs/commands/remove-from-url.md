# `monoceros remove-from-url`

Inverse of [`add-from-url`](./add-from-url.md). Removes an
install-URL entry from the container config.

## Synopsis

```sh
monoceros remove-from-url <containername> <url> [--yes]
```

The URL must exactly match the one stored in the config.

## Mechanics

The yml entry in `installUrls:` is removed. On the next `apply`, the
URL call drops out of `.devcontainer/post-create.sh`.

**Caution — the install script's result stays in the container.** If
the original install installed a binary, after `remove-from-url` +
`apply` it is no longer part of the build process, but it remains
present in the existing container until that container is re-created.
For a fully clean state:

```sh
monoceros remove-from-url sandbox https://example.com/install --yes
monoceros down sandbox       # container gone, volumes kept
monoceros apply sandbox      # bring it back up, without the install step
```

## Idempotency

URL not in the list → no-change.

## Related commands

- `monoceros add-from-url` — inverse
- `monoceros down <name>` — re-create the container
- `monoceros apply <name>` — materialization
