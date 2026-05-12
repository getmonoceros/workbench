---
description: Run one Plan/Generate/Review iteration with the given prompt
argument-hint: <prompt>
allowed-tools: Bash(monoceros-plugin iterate:*)
---

Run a Monoceros iteration over the current solution workspace.

Execute exactly:

```
monoceros-plugin iterate -- "$ARGUMENTS"
```

## How to present the output

The script's stdout is **already a finished Markdown report** —
headings (`## ✓ Iteration …`), sections (`### Acceptance Criteria`,
`### Files changed`, `### Tests`, `### Captured`, `### Reviewer`),
bullet lists, code spans for filenames and ids. Do **not** write your
own summary, do **not** re-interpret, do **not** condense.

Your message to the Builder is exactly the bash stdout, rendered as
Markdown. Copy it across verbatim. The Builder reads the rendered
result, not your paraphrase.

If the script exits non-zero, the stdout still contains the
Markdown-rendered failure report — surface that as-is too. Only add
your own words if stderr contains content the Markdown report did not
already cover.
