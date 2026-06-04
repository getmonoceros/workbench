/**
 * Marker blocks for files Monoceros writes into the container workspace
 * that the user may also edit (today: `AGENTS.md`).
 *
 * Apply overwrites only the content between `MARKER_BEGIN` and
 * `MARKER_END`; anything outside those markers in the file survives
 * the next apply. HTML comments are used because Claude Code strips
 * them from the context before reading, so the markers cost no tokens
 * in the AI session — they're a file-level concern only.
 *
 * If a target file exists but does not contain both markers, apply
 * treats the file as Monoceros-owned and rewrites it entirely with
 * markers. The user has to put their notes *outside* the markers from
 * the start; this is documented in the briefing's own user-notes
 * section.
 */

export const MARKER_BEGIN = '<!-- monoceros:begin -->';
export const MARKER_END = '<!-- monoceros:end -->';

/**
 * Wrap a Monoceros-generated block with the begin/end markers and
 * the standard user-notes footer. The result is the full file body
 * for a fresh write.
 */
export function wrapWithMarkers(generated: string): string {
  const trimmed = generated.replace(/\n+$/, '');
  return [
    MARKER_BEGIN,
    '',
    trimmed,
    '',
    MARKER_END,
    '',
    '## My own notes',
    '',
    '(Anything outside the `monoceros:begin`/`end` markers is yours.',
    'Monoceros will not touch this section on the next `apply`.)',
    '',
  ].join('\n');
}

/**
 * Replace the content between begin/end markers in an existing file
 * with the new generated block. Preserves everything outside the
 * markers. Returns `null` if the file does not contain both markers
 * — the caller decides whether to fall back to a full rewrite.
 */
export function replaceMarkerBlock(
  existing: string,
  generated: string,
): string | null {
  const begin = existing.indexOf(MARKER_BEGIN);
  const end = existing.indexOf(MARKER_END);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  const before = existing.slice(0, begin);
  const after = existing.slice(end + MARKER_END.length);
  const trimmed = generated.replace(/\n+$/, '');
  return `${before}${MARKER_BEGIN}\n\n${trimmed}\n\n${MARKER_END}${after}`;
}
