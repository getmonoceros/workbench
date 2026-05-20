import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { workbenchCheckoutRoot } from '../config/paths.js';
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
 * disk at init time. The fallback is "no hints", which is exactly
 * right: we don't speculate about other people's feature options.
 *
 * Manifests live at the **workbench checkout root**, not inside the
 * shipped CLI bundle. In production (npm-installed CLI) the checkout
 * isn't present, so the loader returns "no hints" — `init` keeps
 * working, just without the commented suggestion lines.
 */

export interface FeatureManifestSummary {
  /** Names of options to render as commented hints in the init output. */
  optionHints: string[];
}

export function loadFeatureManifestSummary(
  ref: string,
  checkoutRoot: string | null = workbenchCheckoutRoot(),
): FeatureManifestSummary | undefined {
  if (!checkoutRoot) return undefined;
  const match = matchMonocerosFeature(ref);
  if (!match) return undefined;
  const name = match.name;
  const manifestPath = path.join(
    checkoutRoot,
    'images',
    'features',
    name,
    'devcontainer-feature.json',
  );
  if (!existsSync(manifestPath)) return undefined;
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
