import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bundledFeaturesDir, workbenchCheckoutRoot } from '../config/paths.js';
import { matchMonocerosFeature } from '../util/ref.js';

/**
 * Loader for the parts of a Monoceros devcontainer-feature manifest
 * that init's yml-generator wants to surface as inline guidance:
 *
 *   - `name` / `description` — the feature's tagline / prose, copied
 *     verbatim from the standard devcontainer-feature.json top-level
 *     fields. The generator builds the header comment block from
 *     these — no fallback prose lives in the generator itself.
 *   - `documentationURL` — copied verbatim. The generator emits a
 *     "See <url> for further information." line when this is a real
 *     URL. Empty / missing / literal "tbd" → line omitted.
 *   - `optionHints` — names of feature options the generator emits
 *     as commented lines under the rendered `options:` block, so the
 *     builder sees what's settable without opening the docs.
 *   - `optionDescriptions` — per-option `description` from the
 *     manifest. The generator weaves these into the per-feature
 *     "Options: …" summary comment.
 *   - `usageNotes` — free-text per-feature paragraphs from
 *     `x-monoceros.usageNotes`. Concatenated into the header prose
 *     after `description`.
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
  /** `name` field — short product/tagline. Empty string when unset. */
  name: string;
  /** `description` field — multi-sentence prose. Empty string when unset. */
  description: string;
  /**
   * `documentationURL` — only set when it's a real URL.
   * `tbd` / `TBD` / empty / unset → undefined. The generator uses
   * this to suppress the "See <url>…" line when no real docs exist
   * yet, so the file doesn't fill with placeholders.
   */
  documentationURL: string | undefined;
  /** Names of options to render as commented hints in the init output. */
  optionHints: string[];
  /** `description` from each option in the manifest, keyed by name. */
  optionDescriptions: Record<string, string>;
  /** Free-text per-feature notes rendered above the `- ref:` line. */
  usageNotes: string[];
}

interface RawManifest {
  name?: string;
  description?: string;
  documentationURL?: string;
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

    const name = typeof parsed.name === 'string' ? parsed.name : '';
    const description =
      typeof parsed.description === 'string' ? parsed.description : '';
    const rawUrl =
      typeof parsed.documentationURL === 'string'
        ? parsed.documentationURL.trim()
        : '';
    const documentationURL =
      rawUrl.length > 0 && rawUrl.toLowerCase() !== 'tbd' ? rawUrl : undefined;

    return {
      name,
      description,
      documentationURL,
      optionHints,
      optionDescriptions,
      usageNotes,
    };
  } catch {
    return undefined;
  }
}
