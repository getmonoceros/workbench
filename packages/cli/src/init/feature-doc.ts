import type { FeatureManifestSummary } from './manifest.js';

/**
 * Shared per-feature header builder. Both `init`'s yml generator and
 * `add-feature`'s AST mutator consume this: the generator emits each
 * line as a `# `-prefixed string in a line-array, the mutator joins
 * the lines into a yaml-lib `commentBefore` string on the new
 * feature pair.
 *
 * Returns the wrapped paragraph lines WITHOUT a `#` prefix or leading
 * space — the consumer adds whichever convention applies (`# Foo` for
 * the generator, ` Foo` for yaml-lib's stored-after-`#` form).
 *
 * Format mirrors `monoceros-config.sample.yml`'s per-feature blocks:
 *   - `<Name> — <description>` (one paragraph, wrapped)
 *   - `<usageNote>` (one paragraph per note, wrapped)
 *   - `Options: <key> (<short-desc>), …` (wrapped)
 *   - `See <documentationURL> for further information.`
 *
 * An empty / unknown manifest summary returns `[]` — the caller emits
 * just the `- ref:` line without prose. Same fallback shape as the
 * generator's documented-mode third-party path.
 */
export function buildFeatureHeaderLines(
  summary: FeatureManifestSummary | undefined,
  width: number,
): string[] {
  const paragraphs = buildHeaderParagraphs(summary);
  const wrapped: string[] = [];
  for (const para of paragraphs) {
    for (const line of wrapToComment(para, width)) {
      wrapped.push(line);
    }
  }
  return wrapped;
}

/**
 * Same as `buildFeatureHeaderLines` but each line gets a leading
 * single space, matching yaml-lib's `commentBefore` storage
 * convention (which prepends `#` and prints the body verbatim). Use
 * when setting `commentBefore` on a Scalar or Pair node.
 */
export function buildFeatureHeaderCommentBefore(
  summary: FeatureManifestSummary | undefined,
  width: number,
): string {
  const lines = buildFeatureHeaderLines(summary, width);
  return lines.map((l) => ` ${l}`).join('\n');
}

function buildHeaderParagraphs(
  summary: FeatureManifestSummary | undefined,
): string[] {
  if (!summary) return [];
  const out: string[] = [];
  const tagline = summary.name?.trim();
  const description = summary.description?.trim();
  if (tagline && description) {
    out.push(`${tagline} — ${description}`);
  } else if (tagline) {
    out.push(tagline);
  } else if (description) {
    out.push(description);
  }
  for (const note of summary.usageNotes) {
    const trimmed = note.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  if (summary.optionHints.length > 0) {
    const parts = summary.optionHints.map((key) => {
      const desc = summary.optionDescriptions[key];
      const short = desc ? shortenOptionDescription(desc) : undefined;
      return short ? `${key} (${short})` : key;
    });
    out.push(`Options: ${parts.join(', ')}.`);
  }
  if (summary.documentationURL) {
    out.push(`See ${summary.documentationURL} for further information.`);
  }
  return out;
}

/**
 * Trim a per-option `description` to a parenthetical hint — first
 * sentence, trailing punctuation stripped. Length cap is intentionally
 * absent: feature manifests are expected to keep descriptions terse;
 * the wrap function downstream handles line breaks naturally.
 */
function shortenOptionDescription(desc: string): string {
  const firstSentence = desc.split(/(?<=[.!?])\s+/)[0]?.trim() ?? desc.trim();
  return firstSentence.replace(/[.!?]+$/, '').trim();
}

/**
 * Word-wrap a single paragraph of plain text to `width` columns. The
 * returned strings do NOT include any prefix — the caller is expected
 * to prepend a comment marker (`# `) and indent. Long words that
 * exceed `width` are emitted on their own line rather than split
 * mid-word.
 */
export function wrapToComment(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [''];
  const usable = Math.max(width, 20);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (current.length === 0) {
      current = w;
      continue;
    }
    if (current.length + 1 + w.length <= usable) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Default comment width matching the generator's. */
export const FEATURE_HEADER_WIDTH = 76 - 2; // COMMENT_WIDTH - "# " prefix
