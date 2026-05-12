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
glyphs and column alignment. It contains sections including
`Iteration … — <recommendation>`, the per-phase timing block,
`Acceptance Criteria`, `Files changed`, `Tests`, `Captured`,
`Reviewer`, and a footer with the iteration id and audit path.

Your response message must follow this exact shape:

1. **A fenced code block** containing the entire bash stdout
   verbatim. The fence preserves the column alignment and prevents
   markdown from collapsing the whitespace.

2. **One single line right after the code block**, listing the
   changed files (and only the changed files) as inline code spans
   so Claude Code renders them as clickable links. Format:

   ```
   Files: `path/one.js` · `path/two.js` · `path/three.js`
   ```

   Pull the paths from the "Files changed" section of the report.
   Mark created files with a leading `+ ` inside the backtick span,
   modified with `~ `, deleted with `- ` — keep the same glyphs the
   report uses. If there were no file changes, omit this line.

That's it. Do **not** add a preamble, do **not** write a summary, do
**not** paraphrase the Reviewer text. The code block already contains
everything the Builder needs to read; the `Files:` line exists only
to give them clickable navigation.

If the bash command exits non-zero, the stdout still contains the
formatted failure report — render it the same way (in a code block).
Skip the `Files:` line in that case (there are typically no file
changes on failure). Only add words of your own if the stderr carries
content that the formatted report did not cover.
