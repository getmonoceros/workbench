import { deriveRepoName } from '../create/scaffold.js';
import type {
  CreateOptions,
  FeatureOptions,
  StackFile,
} from '../create/types.js';
import { CONFIG_SCHEMA_VERSION, type SolutionConfig } from './schema.js';

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

/**
 * Inverse direction — turn a legacy M1 StackFile into a Phase-3
 * SolutionConfig. Used by the apply migration path to seed
 * `.local/container-configs/<name>.yml` on first apply of a
 * stack.json-backed solution.
 *
 * Conversions:
 *   - features Record → features[] (each entry only carries `options`
 *     if non-empty, so the generated yml stays minimal)
 *   - externalServices.postgres → externalServices.postgres (1:1)
 *   - repos: explicit `name` is preserved only when it differs from
 *     the URL-derived default, matching the `add-repo` heuristic
 *
 * Fields the stack didn't carry (`git.user`) are omitted; identity
 * still flows through host-side `git config --global` on apply.
 */
export function stackFileToSolutionConfig(stack: StackFile): SolutionConfig {
  const features = Object.entries(stack.features ?? {}).map(
    ([ref, options]) => ({
      ref,
      ...(Object.keys(options).length > 0 ? { options } : {}),
    }),
  );
  const repos = (stack.repos ?? []).map((r) => {
    const derived = deriveRepoName(r.url);
    return {
      url: r.url,
      ...(r.name !== derived ? { name: r.name } : {}),
      ...(r.branch !== undefined ? { branch: r.branch } : {}),
    };
  });
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    name: stack.name,
    languages: [...stack.languages],
    aptPackages: [...(stack.aptPackages ?? [])],
    features,
    installUrls: [...(stack.installUrls ?? [])],
    services: [...stack.services],
    repos,
    externalServices: stack.externalServices.postgres
      ? { postgres: stack.externalServices.postgres }
      : {},
  };
}
