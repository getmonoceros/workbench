/**
 * Generates the body of `CLAUDE.md` — the Monoceros block that sits
 * between the marker comments in the container workspace root, next
 * to `AGENTS.md`. The caller wraps it with markers (and the
 * user-notes section) via `wrapWithMarkers` in `briefing/index.ts`.
 *
 * The body is the single line `@AGENTS.md` — Claude Code's documented
 * mechanism for AGENTS.md co-existence: an import that pulls in the
 * AGENTS.md content at session start so no Monoceros instructions
 * need to be duplicated here.
 *
 * The file is wrapped in marker comments so a builder can add
 * Claude-Code-specific instructions below the markers (e.g. a rule
 * that only Claude Code interprets and that wouldn't make sense in
 * the multi-tool AGENTS.md). Apply preserves anything outside the
 * markers. AGENTS.md is the better place for content shared across
 * tools; CLAUDE.md is here for the Claude-only edge case.
 */
export function generateClaudeMd(): string {
  return '@AGENTS.md';
}
