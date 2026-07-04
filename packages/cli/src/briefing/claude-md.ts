/**
 * Generates the body of `CLAUDE.md` - the Monoceros block that sits
 * between the marker comments in the container workspace root, next
 * to `AGENTS.md`. The caller wraps it with markers (and the
 * user-notes section) via `wrapWithMarkers` in `briefing/index.ts`.
 *
 * The body is a short instruction that points Claude Code at
 * `AGENTS.md` via its `@`-import. A bare `@AGENTS.md` import line is
 * Claude Code's documented AGENTS.md mechanism, but in practice - and
 * especially in a one-shot `monoceros run … claude "<task>"` - Claude
 * often reads CLAUDE.md without actually following the import and
 * acting on the briefing. Phrasing it as an explicit "read this first"
 * instruction (that still contains the `@AGENTS.md` token, so the
 * import fires when it does) makes the agent open the briefing
 * reliably.
 *
 * The file is wrapped in marker comments so a builder can add
 * Claude-Code-specific instructions below the markers (e.g. a rule
 * that only Claude Code interprets and that wouldn't make sense in
 * the multi-tool AGENTS.md). Apply preserves anything outside the
 * markers. AGENTS.md is still the single source for content shared
 * across tools; CLAUDE.md just routes Claude to it.
 */
export function generateClaudeMd(): string {
  return [
    "Read @AGENTS.md before you do anything else. It is this container's",
    'briefing - the stack, services, tools, exposed ports, and how to work in',
    'here - and Monoceros regenerates it on every `apply`.',
  ].join('\n');
}
