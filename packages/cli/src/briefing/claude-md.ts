/**
 * `CLAUDE.md` next to `AGENTS.md` in the container workspace root.
 *
 * Single line — Claude Code's documented mechanism for AGENTS.md
 * co-existence: a `CLAUDE.md` containing `@AGENTS.md` imports the
 * AGENTS.md content at session start. The user does not edit this
 * file; it is entirely Monoceros-owned and rewritten on every apply.
 */
export function generateClaudeMd(): string {
  return '@AGENTS.md\n';
}
