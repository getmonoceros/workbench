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

The bash stdout is a structured plain-text report with Unicode glyphs
and column alignment. Section headers it contains: `Iteration … —
<recommendation>`, per-phase timing block, `Acceptance Criteria`,
`Files changed`, `Tests`, `Captured`, `Reviewer`, footer with id and
audit path.

Your response must follow this exact shape — **two parts and nothing
else**:

### Part 1 — fenced code block with the bash stdout verbatim

```
<the entire bash stdout, unchanged>
```

The fence preserves whitespace and column alignment. Do not edit,
trim, summarise or rewrap the content. Do not insert your own
commentary inside the fence.

### Part 2 — exactly two short lines right after the fence

**Line A — outcome + next action**, picked from this table by the
`recommendation` (or failure) shown in the report. Substitute the
italicised placeholders with values from the report. Use the exact
wording otherwise.

| Recommendation                      | Line A template                                                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `approve`, no captured items        | **approve** — workspace updated. Nothing to triage.                                                                              |
| `approve`, items captured           | **approve** — workspace updated. Run `/findings` to inspect the _N_ captured items.                                              |
| `request_changes`                   | **request_changes** — Reviewer flagged _N_ findings. Run `/findings` to see them, then `/iterate` again with a follow-up prompt. |
| `reject`                            | **reject** — Reviewer rejected, workspace was rewound. Read the Reviewer summary above before the next `/iterate`.               |
| Pipeline failed (no recommendation) | **FAILED** in `<phase>` — see the audit JSON at the path shown above for the full trace.                                         |

**Line B — clickable file references**, one line, listing the
changed files from the "Files changed" section of the report. Each
path wrapped in a code span (` `` `) so Claude Code auto-links it.
Mirror the same `+ ` / `~ ` / `- ` glyphs the report uses for
created/modified/deleted:

```
Files: `+ path/one.js` · `~ path/two.js` · `- path/three.js`
```

If there were no file changes (e.g. on failure), omit Line B
entirely.

### What not to do

- **No** preamble before the code block ("Here is the result …").
- **No** summary or paraphrase of the Reviewer text — the Builder
  reads it from the report.
- **No** commentary, observations or your own analysis between or
  after the two lines. If you have something to say beyond the
  template, it does not belong here.

The report above already contains everything the Builder needs to
understand the iteration. Your role is to render it cleanly and
point to the next action.
