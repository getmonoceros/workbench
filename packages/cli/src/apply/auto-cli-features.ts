import {
  gitTokenEnvVar,
  uniqueHttpsHosts,
} from '../devcontainer/credentials.js';
import { loadComponentCatalog } from '../init/components.js';
import type { CreateOptions, FeatureOptions } from '../create/types.js';

export interface CliFeatureOutcome {
  /** Display names of CLI features actually auto-added (with a token). */
  added: string[];
  /**
   * Provider repos that were cloned without a configured PAT (so the
   * credential came from the host keychain). No CLI feature was added for
   * these: an unauthenticated gh/glab would be a silent half-state. The
   * caller surfaces this so the builder knows gh/glab is NOT set up and
   * which env var to set to fix it.
   */
  missingToken: Array<{ provider: string; host: string; envVar: string }>;
}

/**
 * Auto-add the matching git-provider CLI feature (github-cli / gitlab-cli)
 * for each declared repo provider, authenticated from the PAT in the
 * merged env (ADR 0031). The features expose an `apiToken` option (and
 * gitlab a `host` option) that wires up `gh`/`glab` auth on first start.
 *
 * Only added when a PAT is actually configured for the host: without a
 * token the feature can't be authenticated, and a present-but-dead CLI is
 * worse than no CLI (apply looks green while `gh auth status` fails inside
 * the container). Such hosts are returned in `missingToken` so the caller
 * can tell the builder. (The clone itself still works via the keychain
 * fallback; that is separate from gh/glab auth.)
 *
 * Mutates `createOpts.features`. A provider whose CLI feature the builder
 * already declared in the yml is left untouched (explicit config wins).
 *
 * Scope: GitHub + GitLab, the providers with a verified env-PAT path.
 * GitHub Enterprise auto-auth (GH_ENTERPRISE_TOKEN) is a feature-side
 * follow-up.
 */
export async function autoAddRepoCliFeatures(
  createOpts: CreateOptions,
  envVars: Record<string, string>,
): Promise<CliFeatureOutcome> {
  const repos = createOpts.repos ?? [];
  if (repos.length === 0) return { added: [], missingToken: [] };

  const hostProviders = uniqueHttpsHosts(repos);
  const catalog = await loadComponentCatalog();
  const features = (createOpts.features ??= {});
  const added: string[] = [];
  const missingToken: CliFeatureOutcome['missingToken'] = [];

  for (const provider of ['github', 'gitlab'] as const) {
    const hosts = hostProviders
      .filter((h) => h.provider === provider)
      .map((h) => h.host);
    if (hosts.length === 0) continue;

    const host = hosts[0]!;
    const envVar = gitTokenEnvVar(host);
    const token = envVars[envVar];
    if (!token) {
      // No PAT: don't auto-add an unauthenticated CLI. Flag it instead.
      missingToken.push({ provider, host, envVar });
      continue;
    }

    const component = catalog.get(provider);
    const ref = component?.file.contributes.features?.[0]?.ref;
    if (!ref) continue; // catalog without the CLI feature: nothing to add
    // Builder already declared it: respect their config, don't override.
    if (Object.prototype.hasOwnProperty.call(features, ref)) continue;

    const options: FeatureOptions = { apiToken: token };
    // glab targets gitlab.com unless `host` is set; point it at a
    // self-managed host so every command uses it without --hostname.
    if (provider === 'gitlab' && host.toLowerCase() !== 'gitlab.com') {
      options.host = host;
    }
    features[ref] = options;
    added.push(component!.name);
  }

  return { added, missingToken };
}
