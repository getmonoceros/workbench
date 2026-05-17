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
 */
export function solutionConfigToCreateOptions(
  config: SolutionConfig,
): CreateOptions {
  const featureRecord: Record<string, FeatureOptions> = {};
  for (const entry of config.features) {
    featureRecord[entry.ref] = entry.options ?? {};
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
