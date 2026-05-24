import { deriveRepoName } from '../create/scaffold.js';
import type { CreateOptions, FeatureOptions } from '../create/types.js';
import { portNumber, type SolutionConfig } from './schema.js';

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
      // `path` is optional in the yml; CreateOptions requires it.
      // When the yml omits `path`, fall back to the URL-derived
      // single-segment default (`https://.../foo.git` → `foo`),
      // which lands the clone at `projects/foo/`.
      path: r.path ?? deriveRepoName(r.url),
      ...(r.git?.user
        ? { gitUser: { name: r.git.user.name, email: r.git.user.email } }
        : {}),
      ...(r.provider ? { provider: r.provider } : {}),
    }));
  }
  const routingPorts = config.routing?.ports ?? [];
  if (routingPorts.length > 0) {
    // Collapse both yml forms (`- 3000` and `- port: 9229`) to a flat
    // number array. Dedupe by port number — repeated entries in the
    // yml would otherwise show up twice in `forwardPorts` and in the
    // Traefik route set.
    const seen = new Set<number>();
    const ports: number[] = [];
    for (const entry of routingPorts) {
      const n = portNumber(entry);
      if (seen.has(n)) continue;
      seen.add(n);
      ports.push(n);
    }
    result.ports = ports;
  }
  if (config.routing?.vscodeAutoForward !== undefined) {
    result.vscodeAutoForward = config.routing.vscodeAutoForward;
  }
  return result;
}
