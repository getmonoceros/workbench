import { deriveRepoName } from '../create/scaffold.js';
import type { CreateOptions, FeatureOptions } from '../create/types.js';
import type { SolutionConfig } from './schema.js';

/**
 * Translate a yml-shaped `SolutionConfig` into the `CreateOptions`
 * shape the existing scaffolders (devcontainer.json, compose.yaml,
 * post-create.sh) consume.
 *
 * The big shape mismatch is `features`:
 *   - yml:           `[{ ref, options }, …]`  (array; humans edit/comment this)
 *   - CreateOptions: `Record<ref, options>`   (devcontainer.json shape)
 * We dedupe by `ref` and keep the LAST occurrence — same rule the
 * existing `add-feature` command uses when a builder re-adds with new
 * options.
 *
 * `externalServices.postgres` → `postgresUrl` (the CreateOptions
 * field name predates the yml schema; rename would touch every M1
 * caller, so the translator absorbs the diff here).
 *
 * `featureDefaults` (optional) — `defaults.features` from
 * `monoceros-config.yml`. Per-container options always override these;
 * keys not set per-container fall back to the default. A feature ref
 * that exists only in `featureDefaults` (not in the container yml)
 * does NOT get included — the container yml is what decides whether
 * a feature is active at all; the defaults only fill in option values.
 */
export function solutionConfigToCreateOptions(
  config: SolutionConfig,
  featureDefaults: Record<string, FeatureOptions> = {},
): CreateOptions {
  const featureRecord: Record<string, FeatureOptions> = {};
  for (const entry of config.features) {
    const defaults = featureDefaults[entry.ref] ?? {};
    featureRecord[entry.ref] = { ...defaults, ...(entry.options ?? {}) };
  }

  const result: CreateOptions = {
    name: config.name,
    languages: [...config.languages],
    services: [...config.services],
  };

  if (config.externalServices.postgres !== undefined) {
    result.postgresUrl = config.externalServices.postgres;
  }
  if (config.aptPackages.length > 0) {
    result.aptPackages = [...config.aptPackages];
  }
  if (Object.keys(featureRecord).length > 0) {
    result.features = featureRecord;
  }
  if (config.installUrls.length > 0) {
    result.installUrls = [...config.installUrls];
  }
  if (config.repos.length > 0) {
    result.repos = config.repos.map((r) => ({
      url: r.url,
      // `name` is optional in the yml (derived from URL on apply),
      // required in CreateOptions; the caller derives it via
      // `deriveRepoName` when undefined.
      name: r.name ?? deriveRepoName(r.url),
      ...(r.branch !== undefined ? { branch: r.branch } : {}),
    }));
  }
  return result;
}
