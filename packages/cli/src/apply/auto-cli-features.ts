import {
  gitTokenEnvVar,
  uniqueHttpsHosts,
} from '../devcontainer/credentials.js';
import { loadComponentCatalog } from '../init/components.js';
import type { CreateOptions, FeatureOptions } from '../create/types.js';

/**
 * Auto-add the matching git-provider CLI feature (github-cli / gitlab-cli)
 * for each declared repo provider, authenticated from the PAT in the
 * merged env (ADR 0031). The features already expose an `apiToken` option
 * (and gitlab a `host` option) that wires up `gh`/`glab` auth on the first
 * container start, so this is just "add the feature with its token set".
 *
 * Mutates `createOpts.features`. A provider whose CLI feature the builder
 * already declared in the yml is left untouched (explicit config wins).
 * Returns the display names actually added, for logging.
 *
 * Scope: GitHub + GitLab, the providers with a verified env-PAT path.
 * GitHub Enterprise auto-auth (GH_ENTERPRISE_TOKEN) is a feature-side
 * follow-up; the feature is still added and the token still set. Reached
 * only after the credential pre-flight, so by here every host already has
 * a credential (PAT or keychain); a host whose credential came from the
 * keychain just yields a feature with no token (first-run `auth login`).
 */
export async function autoAddRepoCliFeatures(
  createOpts: CreateOptions,
  envVars: Record<string, string>,
): Promise<string[]> {
  const repos = createOpts.repos ?? [];
  if (repos.length === 0) return [];

  const hostProviders = uniqueHttpsHosts(repos);
  const catalog = await loadComponentCatalog();
  const features = (createOpts.features ??= {});
  const added: string[] = [];

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
    const options: FeatureOptions = {};
    const token = envVars[gitTokenEnvVar(host)];
    if (token) options.apiToken = token;
    // glab targets gitlab.com unless `host` is set; point it at a
    // self-managed host so every command uses it without --hostname.
    if (provider === 'gitlab' && host.toLowerCase() !== 'gitlab.com') {
      options.host = host;
    }
    features[ref] = options;
    added.push(component!.name);
  }

  return added;
}
