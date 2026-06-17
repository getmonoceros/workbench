# ADR 0024: add-feature merges sub-tool selectors additively

- Status: accepted
- Date: 2026-06-17

## Context

A multi-tool feature like `atlassian` exposes its sub-tools through preset
selectors that all resolve to one feature ref: `atlassian` (all on),
`atlassian/rovodev`, `atlassian/twg`, `atlassian/forge`. Each preset is a
set of toggle values; at `init` the bare selector gives every tool, a
`name/preset` selector gives just that one.

`add-feature` matched an existing entry by ref and, if the options differed,
refused with "already configured with different options. Remove it first".
That made the natural command for "I have twg, also give me forge" fail:

    monoceros add-feature sandbox atlassian/forge
    # ERROR: already configured with different options

Worse, the suggested remedy (`remove-feature atlassian/forge`) removes the
whole atlassian entry by ref, so re-adding the forge preset would drop the
builder's twg. The error was technically correct but pushed the builder
toward losing configuration.

Two fixes were considered and rejected:

- Threading explicit `-- key=value` toggles (`atlassian -- forge=true
rovodev=true twg=false`) as the merge mechanism. Too large: it changes the
  CLI surface, the web command docs, the landing page, and doesn't match the
  `init` mental model where the slash selectors are the interface.
- Replacing the existing entry's options wholesale with the preset's set.
  That switches sibling tools off (the forge preset sets `twg: false`),
  which is not what "add forge" means.

## Decision

`add-feature` keeps the same four selectors and gains one behavior: when the
ref is already present, a **sub-tool selector** (anything with a `/`, e.g.
`atlassian/forge`) **merges additively** into the existing entry, using the
exact rule `init` already uses to combine components (`mergeFeatureOptions`):

- booleans: OR (true wins) — so adding one sub-tool never switches another
  off;
- strings / numbers: the new value overrides.

A **plain feature, bare selector, or raw OCI ref** (no `/`) keeps the prior
overwrite-protected behavior: same options is a no-op, different options is
the explicit "remove first" error. Once `claude` or `github` is in the yml,
re-adding never silently rewrites it.

So the builder's reported command now does the obvious thing:

    monoceros add-feature sandbox atlassian/forge
    # twg stays true (true OR false), forge flips to true, rovodev stays off

The selectors mean the same in `init` and `add-feature`: `atlassian` is all
tools, `atlassian/<tool>` is that tool, combining them unions. No new
syntax, `init` and the landing page are untouched.

## Consequences

- The fix is one merge call gated on whether the selector is a preset; the
  catalog, `init`, and the published feature manifests are unchanged.
- `add-feature` is purely **additive** for sub-tools: it can turn a tool on,
  never off (OR never clears a `true`). Turning a sub-tool off is a yml edit,
  or `remove-feature` to drop the whole feature. This matches the verb.
- The web command reference for `add-feature` needs the one-line update:
  sub-tool selectors merge in; plain features stay overwrite-protected.
