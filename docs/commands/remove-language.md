# `monoceros remove-language`

The inverse of [`add-language`](../README.md#hinzufügen). Removes a
language entry from the container config.

## Synopsis

```sh
monoceros remove-language <containername> <lang> [--yes]
```

## Mechanics

Edits the yml at `$MONOCEROS_HOME/container-configs/<name>.yml`: the
entry in `languages:` is removed; if the list becomes empty, the field
is dropped entirely. Comment-preserving — other entries and comments
remain unchanged.

After the call, `monoceros apply <containername>` must run so that the
container picks up the change.

## Idempotency

`remove-language sandbox python` twice in a row → the second call is a
no-op.

## Example

```sh
monoceros remove-language sandbox python --yes
monoceros apply sandbox
```

## Related commands

- `monoceros add-language` — the inverse
- `monoceros apply <name>` — materialization after the edit
