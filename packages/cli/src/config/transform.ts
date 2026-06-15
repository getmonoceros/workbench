import { resolveService } from '../create/catalog.js';
import { deriveRepoName } from '../create/scaffold.js';
import type { CreateOptions, FeatureOptions } from '../create/types.js';
import { portNumber, type SolutionConfig } from './schema.js';

type LanguageOptionValue = string | number | boolean;

/**
 * Normalize the yml `languages` array (mixed string + object form) into the
 * CreateOptions shape: a `name[:version]` string list plus a per-language
 * options map (object form only, version stripped out into the suffix).
 */
function normalizeLanguages(entries: SolutionConfig['languages']): {
  languages: string[];
  languageOptions: Record<string, Record<string, LanguageOptionValue>>;
} {
  const languages: string[] = [];
  const languageOptions: Record<
    string,
    Record<string, LanguageOptionValue>
  > = {};
  for (const entry of entries) {
    if (typeof entry === 'string') {
      languages.push(entry);
      continue;
    }
    // Object form: single-key map `{ <name>: { version?, ...options } }`.
    const name = Object.keys(entry)[0]!;
    const opts = { ...entry[name] };
    const version = opts.version;
    delete opts.version;
    languages.push(version !== undefined ? `${name}:${String(version)}` : name);
    if (Object.keys(opts).length > 0) languageOptions[name] = opts;
  }
  return { languages, languageOptions };
}

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
    // Per-container options override defaults, EXCEPT when the
    // container value is the empty string. A bare `apiKey:` in the
    // yml parses to null and the schema relaxes that to `""`; the
    // init-generator also writes hint keys without a value. In both
    // cases the builder's intent is "leave this unset, fall through
    // to the global default" — not "explicitly clear the default".
    // Skip empty strings so the merge respects that.
    const containerOpts = Object.fromEntries(
      Object.entries(entry.options ?? {}).filter(([, v]) => v !== ''),
    );
    featureRecord[entry.ref] = { ...defaults, ...containerOpts };
  }

  const { languages, languageOptions } = normalizeLanguages(config.languages);

  const result: CreateOptions = {
    name: config.name,
    ...(config.runtimeVersion !== undefined
      ? { runtimeVersion: config.runtimeVersion }
      : {}),
    languages,
    // Normalize every services[] entry (curated string or explicit
    // object) to the canonical ResolvedService shape. `${VAR}` values
    // survive untouched here — apply interpolates them against
    // <name>.env afterwards.
    services: config.services.map(resolveService),
  };

  if (Object.keys(languageOptions).length > 0) {
    result.languageOptions = languageOptions;
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
      // gitUser is forwarded only when BOTH name + email are set.
      // The relaxed GitUserSchema accepts nullable / empty strings
      // (so a yml placeholder `name:` parses without error), so we
      // re-check here before downstream code, which expects both
      // values to be non-empty.
      ...(r.git?.user?.name && r.git.user.email
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
