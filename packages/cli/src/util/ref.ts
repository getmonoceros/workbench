/**
 * Shape detection for OCI refs that point at Monoceros-owned
 * devcontainer features. Two regexes live here:
 *
 *  - `MONOCEROS_FEATURE_RE` matches the current ref shape
 *    (`ghcr.io/getmonoceros/monoceros-features/<name>:<tag>`),
 *    which is what `monoceros init` writes and what GHCR serves.
 *
 *  - `DEPRECATED_MONOCEROS_FEATURE_RE` matches the legacy shape
 *    (`ghcr.io/monoceros/features/<name>:<tag>`) that was used
 *    before the M4 cut. We keep this only to emit a migration
 *    warning at `apply` time when a builder's yml still carries
 *    the old ref.
 */

const FEATURE_NAME_CHARSET = '[a-z0-9._-]+';
const FEATURE_TAG_CHARSET = '[a-z0-9._-]+';

export const MONOCEROS_FEATURE_RE = new RegExp(
  `^ghcr\\.io/getmonoceros/monoceros-features/(${FEATURE_NAME_CHARSET}):${FEATURE_TAG_CHARSET}$`,
);

export const DEPRECATED_MONOCEROS_FEATURE_RE = new RegExp(
  `^ghcr\\.io/monoceros/features/(${FEATURE_NAME_CHARSET}):(${FEATURE_TAG_CHARSET})$`,
);

/**
 * Extract `{ name }` from a current-shape Monoceros feature ref,
 * or `null` for anything else (third-party features, deprecated
 * shape, malformed input).
 */
export function matchMonocerosFeature(ref: string): { name: string } | null {
  const match = MONOCEROS_FEATURE_RE.exec(ref);
  if (!match) return null;
  return { name: match[1]! };
}

/**
 * Translate a legacy-shape ref into the current-shape ref it would
 * map to (`ghcr.io/monoceros/features/<name>:<tag>` →
 * `ghcr.io/getmonoceros/monoceros-features/<name>:<tag>`). Returns
 * `null` for refs that don't match the legacy shape, so callers can
 * use it as a "should I warn?" check.
 */
export function migrateDeprecatedFeatureRef(ref: string): string | null {
  const match = DEPRECATED_MONOCEROS_FEATURE_RE.exec(ref);
  if (!match) return null;
  const name = match[1]!;
  const tag = match[2]!;
  return `ghcr.io/getmonoceros/monoceros-features/${name}:${tag}`;
}
