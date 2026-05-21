import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bundledFeaturesDir, workbenchCheckoutRoot } from '../config/paths.js';
import { matchMonocerosFeature } from '../util/ref.js';

/**
 * Loader for the `x-monoceros` extension fields in a Monoceros
 * devcontainer-feature manifest, scoped to what the init generator
 * needs. Today that's just `optionHints` — the names of feature
 * options the init generator should render as commented-out lines
 * below the active options block, so a builder reading the yml can
 * see at a glance which auth/credential keys exist without going to
 * the feature's docs.
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
    const parsed = JSON.parse(text) as {
      'x-monoceros'?: { optionHints?: unknown };
    };
    const raw = parsed['x-monoceros']?.optionHints;
    if (!Array.isArray(raw)) return { optionHints: [] };
    const hints = raw.filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    return { optionHints: hints };
  } catch {
    return undefined;
  }
}
