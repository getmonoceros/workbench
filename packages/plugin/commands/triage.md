---
description: Triage an open Monoceros item (jetzt | später | verworfen)
argument-hint: <id> <status>
allowed-tools: Bash(monoceros-plugin triage:*)
---

Mark a Monoceros item with one of the triage statuses: `jetzt`,
`später`, `verworfen`.

Execute:

```
monoceros-plugin triage -- "$1" "$2"
```

Where `$1` is the item id (the filename in `.monoceros/findings/`,
`.monoceros/concerns/` or `.monoceros/risks/` without the `.md`
suffix) and `$2` is the target status.

Report the script's output verbatim. On non-zero exit, surface the
error message — do not retry. If the Builder passed an unknown id
or invalid status, the message will say so.
