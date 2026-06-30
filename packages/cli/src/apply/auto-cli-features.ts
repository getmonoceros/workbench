import {
  gitTokenEnvVar,
  uniqueHttpsHosts,
} from '../devcontainer/credentials.js';
import { loadComponentCatalog } from '../init/components.js';
import type { CreateOptions, FeatureOptions } from '../create/types.js';

export interface AddedCliFeature {
  /** Feature display name (e.g. `github`, `gitlab`). */
  name: string;
  provider: 'github' | 'gitlab';
  host: string;
  /**
   * True when a PAT was found for the host and set as the feature's
   * `apiToken` (so gh/glab is logged in). False when the feature was
   * added without a token: it is installed but NOT authenticated, and
   * the caller surfaces a `<gh|glab> auth login` hint.
   */
  authenticated: boolean;
  /** The env var that, if set, would authenticate this feature. */
  envVar: string;
}

/**
 * Hosts where gh's `GH_TOKEN` authenticates: github.com and Enterprise
 * Cloud (`*.ghe.com`). Self-hosted GitHub Enterprise Server needs a
 * different env var (`GH_ENTERPRISE_TOKEN` + `GH_HOST`) that the github-cli
 * feature does not wire yet, so a PAT cannot auto-authenticate it.
 */
function githubTokenWorks(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'github.com' || h.endsWith('.ghe.com');
}

/**
 * Auto-add the matching git-provider CLI feature (github-cli / gitlab-cli)
 * for each declared repo provider (ADR 0031). The feature is ALWAYS added
 * for a provider repo; when a PAT is configured for the host it is set as
 * the feature's `apiToken` (gitlab also gets `host`), so gh/glab is logged
 * in on first container start. When no PAT is set the feature is still
 * added but unauthenticated; the returned `authenticated: false` lets the
 * caller tell the builder to run `gh auth login` (or set the token).
 *
 * Mutates `createOpts.features`. A provider whose CLI feature the builder
 * already declared in the yml is left untouched (explicit config wins) and
 * is not reported. Returns one entry per feature actually added.
 *
 * Scope: GitHub + GitLab. GitHub Enterprise auto-auth
 * (`GH_ENTERPRISE_TOKEN`) is a feature-side follow-up.
 */
export async function autoAddRepoCliFeatures(
  createOpts: CreateOptions,
  envVars: Record<string, string>,
): Promise<AddedCliFeature[]> {
  const repos = createOpts.repos ?? [];
  if (repos.length === 0) return [];

  const hostProviders = uniqueHttpsHosts(repos);
  const catalog = await loadComponentCatalog();
  const features = (createOpts.features ??= {});
  const added: AddedCliFeature[] = [];

  for (const provider of ['github', 'gitlab'] as const) {
    const hosts = hostProviders
      .filter((h) => h.provider === provider)
      .map((h) => h.host);
    if (hosts.length === 0) continue;

    const component = catalog.get(provider);
    const ref = component?.file.contributes.features?.[0]?.ref;
    if (!ref) continue; // catalog without the CLI feature: nothing to add
    // Builder already declared it: respect their config, don't override.
    if (Object.prototype.hasOwnProperty.call(features, ref)) continue;

    const host = hosts[0]!;
    const envVar = gitTokenEnvVar(host);
    const token = envVars[envVar];
    const options: FeatureOptions = {};
    let authenticated = false;

    if (provider === 'gitlab') {
      // glab targets gitlab.com unless `host` is set; point it at a
      // self-managed host so every command (and a manual `glab auth
      // login`) uses it without --hostname. A PAT authenticates any host.
      if (host.toLowerCase() !== 'gitlab.com') options.host = host;
      if (token) {
        options.apiToken = token;
        authenticated = true;
      }
    } else {
      // github: GH_TOKEN authenticates github.com and *.ghe.com (Enterprise
      // Cloud). Self-hosted Enterprise Server needs GH_ENTERPRISE_TOKEN +
      // GH_HOST, which the feature does not wire yet, so a PAT can't
      // auto-auth it: leave it unauthenticated so the caller shows the
      // `gh auth login --hostname` hint instead of a false "logged in".
      if (token && githubTokenWorks(host)) {
        options.apiToken = token;
        authenticated = true;
      }
    }

    features[ref] = options;
    added.push({
      name: component!.name,
      provider,
      host,
      authenticated,
      envVar,
    });
  }

  return added;
}
