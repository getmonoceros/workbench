const SLUG_MAX_LENGTH = 40;

/**
 * Lower-case, ASCII-clean, hyphen-separated slug derived from a
 * free-form message. Used as the human-readable suffix of an item
 * id; never has to be reversible.
 */
export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned.length === 0) return 'item';
  return cleaned.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
}

/**
 * Converts a `Date` to a filesystem-safe ISO timestamp prefix:
 * `2026-05-11T20-30-12-456Z`. Sorts chronologically as a string.
 */
export function timestampPrefix(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/** Combines timestamp + short random tag + slug into a stable id. */
export function makeItemId(
  date: Date,
  randomSuffix: string,
  slug: string,
): string {
  return `${timestampPrefix(date)}-${randomSuffix}-${slug}`;
}
