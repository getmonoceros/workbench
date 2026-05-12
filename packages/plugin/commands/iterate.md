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

The script's stdout is a structured plain-text report with Unicode
glyphs and indentation — no Markdown markers. Sections include:
`Iteration … — <recommendation>`, the per-phase timing block,
`Acceptance Criteria`, `Files changed`, `Tests`, `Captured`,
`Reviewer`, and a footer with the iteration id and audit path.

Show the entire stdout to the Builder verbatim, inside a fenced code
block so the whitespace and column alignment are preserved.

Do **not** rewrite, paraphrase or condense the report. Do **not** add
a "here is the result" preamble. Do **not** summarise the Reviewer's
text. The Builder reads the report directly.

If the script exits non-zero, the stdout still contains the formatted
failure report — surface that the same way. Add words of your own
only when stderr carries content the report did not already cover.
