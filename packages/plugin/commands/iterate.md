---
description: Run one Plan/Generate/Review iteration with the given prompt
argument-hint: <prompt>
allowed-tools: Bash(monoceros-plugin iterate:*)
---

Run a Monoceros iteration over the current solution workspace.

Execute exactly this command and report the output verbatim:

```
monoceros-plugin iterate -- "$ARGUMENTS"
```

The script runs the Planner, Generator and Reviewer phases and writes
the results to `.monoceros/`. It prints a one-screen summary at the end
with the Reviewer's recommendation, the test results, and the number of
findings, concerns and risks persisted. Pass that summary back to the
Builder unchanged.

If the script exits non-zero, surface the stderr output as the error —
do not retry, do not interpret. The Builder triages from there.
