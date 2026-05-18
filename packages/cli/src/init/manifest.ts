import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { workbenchRoot as defaultWorkbenchRoot } from '../config/paths.js';

/**
 * Loader for the `x-monoceros` extension fields in a Monoceros
 * devcontainer-feature manifest, scoped to what the init generator
 * needs. Today that's just `optionHints` — the names of feature
 * options the init generator should render as commented-out lines
 * below the active options block, so a builder reading the yml can
 * see at a glance which auth/credential keys exist without going to
 * the feature's docs.
 *
 * Only Monoceros-owned refs (`ghcr.io/monoceros/features/<name>:<tag>`)
 * are resolved — for third-party features we don't have the manifest
 * on disk at init time. The fallback is "no hints", which is exactly
 * right: we don't speculate about other people's feature options.
 */

export interface FeatureManifestSummary {
  /** Names of options to render as commented hints in the init output. */
  optionHints: string[];
}

const MONOCEROS_FEATURE_RE =
  /^ghcr\.io\/monoceros\/features\/([a-z0-9._-]+):[a-z0-9._-]+$/;

export function loadFeatureManifestSummary(
  ref: string,
  workbenchRoot: string = defaultWorkbenchRoot(),
): FeatureManifestSummary | undefined {
  const match = MONOCEROS_FEATURE_RE.exec(ref);
  if (!match) return undefined;
  const name = match[1]!;
  const manifestPath = path.join(
    workbenchRoot,
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
