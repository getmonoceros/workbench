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

/**
 * Derive the `<name>.env` variable name for a feature option, used as
 * the `${VAR}` placeholder in the yml and the seeded key in the env
 * file. Generic rule `<FEATURE_ID>_<OPTION>`, applied uniformly:
 *   atlassian:1   + apiToken      → ATLASSIAN_API_TOKEN
 *   claude-code:1 + apiKey        → CLAUDE_CODE_API_KEY
 *   github-cli:1  + bitbucketToken→ GITHUB_CLI_BITBUCKET_TOKEN
 *
 * It is a monoceros-side placeholder key — NOT the env var the tool
 * itself reads (the value is passed as the feature's option), so a
 * predictable derived name is honest and avoids per-feature special
 * cases.
 */
export function featureOptionVarName(ref: string, optionKey: string): string {
  const leaf = ref.split('/').pop() ?? ref;
  const id = leaf.split('@')[0]!.split(':')[0]!;
  const idSnake = id.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase();
  const optSnake = optionKey
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
  return `${idSnake}_${optSnake}`;
}

export interface FeatureOptionHint {
  /** Option key, e.g. `apiToken`. */
  key: string;
  /** Derived env var name, e.g. `ATLASSIAN_API_TOKEN`. */
  envVar: string;
  /** yml placeholder, e.g. `${ATLASSIAN_API_TOKEN}`. */
  placeholder: string;
}

/**
 * The credential-bearing option hints for a feature (from the manifest's
 * `x-monoceros.optionHints`), minus any keys already set with an active
 * value. Shared by the init generator (renders `${VAR}` hint lines) and
 * `add-feature` (renders the same as a node comment) and the `.env`
 * seeding (uses `envVar`). Empty for unknown/third-party refs (no
 * manifest → no hints).
 */
export function featureOptionHints(
  summary: FeatureManifestSummary | undefined,
  ref: string,
  activeKeys: readonly string[] = [],
): FeatureOptionHint[] {
  return (summary?.optionHints ?? [])
    .filter((key) => !activeKeys.includes(key))
    .map((key) => {
      const envVar = featureOptionVarName(ref, key);
      return { key, envVar, placeholder: `\${${envVar}}` };
    });
}
