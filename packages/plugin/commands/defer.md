---
description: Manually capture a concern that the pipeline missed
argument-hint: <text>
allowed-tools: Bash(monoceros-plugin defer:*)
---

Capture a manual concern outside of an iteration — for things the
Builder spotted that the pipeline did not.

Execute:

```
monoceros-plugin defer -- "$ARGUMENTS"
```

Report the script's output verbatim. The concern lands in
`.monoceros/concerns/` with `status: open` and a `sourceIteration`
of `"manual"`. It will appear in `/findings` and can be triaged via
`/triage` like any pipeline-captured item.
