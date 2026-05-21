import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bundledFeaturesDir, workbenchCheckoutRoot } from '../config/paths.js';
import { matchMonocerosFeature } from '../util/ref.js';

/**
 * Loader for the parts of a Monoceros devcontainer-feature manifest
 * that init's yml-generator wants to surface as inline guidance:
 *
 *   - `optionHints` — names of feature options to render as
 *     commented-out lines below the active options block, so a
 *     builder reading the yml sees at a glance which keys exist
 *     without going to the feature's docs.
 *   - `optionDescriptions` — the `description` string from each
 *     option in the manifest, keyed by option name. Init prints
 *     these as a wrapped comment block above the matching hint
 *     line so the builder knows what the option does without
 *     opening the feature docs.
 *   - `usageNotes` — free-text per-feature paragraphs from
 *     `x-monoceros.usageNotes`. Init renders them as a comment
 *     block right above the `- ref:` line. Use for things that
 *     aren't tied to one option — e.g. "alternative auth flow X
 *     works inside the running container".
 *
 * Only Monoceros-owned refs
 * (`ghcr.io/getmonoceros/monoceros-features/<name>:<tag>`) are
 * resolved — for third-party features we don't have the manifest on
 * disk at init time. The fallback is "no hints", which is right:
 * we don't speculate about other people's feature options.
 *
 * Manifest lookup order:
 *   1. Workbench checkout — `<checkoutRoot>/images/features/<name>/`.
 *      Dev edits to the source-of-truth manifest are visible
 *      immediately, no rebuild step required.
 *   2. CLI bundle — `<workbenchRoot>/features/<name>/`. Populated
 *      by `pnpm manifests:sync` (runs as `prebuild`), shipped in
 *      the npm tarball. Production fallback for builders without a
 *      workbench checkout.
 *
 * Both paths missing → `undefined` and init renders without hints.
 * Never throws.
 */

export interface FeatureManifestSummary {
  /** Names of options to render as commented hints in the init output. */
  optionHints: string[];
  /** `description` from each option in the manifest, keyed by name. */
  optionDescriptions: Record<string, string>;
  /** Free-text per-feature notes rendered above the `- ref:` line. */
  usageNotes: string[];
}

interface RawManifest {
  options?: Record<string, { description?: string }>;
  'x-monoceros'?: {
    optionHints?: unknown;
    usageNotes?: unknown;
  };
}

function resolveManifestPath(
  name: string,
  checkoutRoot: string | null,
): string | null {
  if (checkoutRoot) {
    const checkoutPath = path.join(
      checkoutRoot,
      'images',
      'features',
      name,
      'devcontainer-feature.json',
    );
    if (existsSync(checkoutPath)) return checkoutPath;
  }
  const bundlePath = path.join(
    bundledFeaturesDir(),
    name,
    'devcontainer-feature.json',
  );
  if (existsSync(bundlePath)) return bundlePath;
  return null;
}

export function loadFeatureManifestSummary(
  ref: string,
  checkoutRoot: string | null = workbenchCheckoutRoot(),
): FeatureManifestSummary | undefined {
  const match = matchMonocerosFeature(ref);
  if (!match) return undefined;
  const manifestPath = resolveManifestPath(match.name, checkoutRoot);
  if (!manifestPath) return undefined;
  try {
    const text = readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(text) as RawManifest;

    const rawHints = parsed['x-monoceros']?.optionHints;
    const optionHints = Array.isArray(rawHints)
      ? rawHints.filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        )
      : [];

    const rawNotes = parsed['x-monoceros']?.usageNotes;
    const usageNotes = Array.isArray(rawNotes)
      ? rawNotes.filter(
          (x): x is string => typeof x === 'string' && x.length > 0,
        )
      : [];

    const optionDescriptions: Record<string, string> = {};
    if (parsed.options) {
      for (const [key, opt] of Object.entries(parsed.options)) {
        if (
          opt &&
          typeof opt === 'object' &&
          typeof opt.description === 'string' &&
          opt.description.length > 0
        ) {
          optionDescriptions[key] = opt.description;
        }
      }
    }

    return { optionHints, optionDescriptions, usageNotes };
  } catch {
    return undefined;
  }
}
