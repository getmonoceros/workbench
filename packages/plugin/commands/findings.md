---
description: List Monoceros findings, concerns and risks captured so far
argument-hint: [--all]
allowed-tools: Bash(monoceros-plugin list:*)
---

## Items

!`monoceros-plugin list $ARGUMENTS`

Present the list above to the Builder. Group by kind (findings,
concerns, risks). Default view is `status: open`; if the Builder
passed `--all` the script already included triaged items.

Do not add commentary — the list is the answer.
