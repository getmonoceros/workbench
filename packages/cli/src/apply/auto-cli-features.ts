import { consola } from 'consola';
import {
  gitTokensForProvider,
  uniqueHttpsHosts,
  type GitTokenChoice,
} from '../devcontainer/credentials.js';
import { loadComponentCatalog } from '../init/components.js';
import type { CreateOptions, FeatureOptions } from '../create/types.js';

/**
 * Interactive picker, used when more than one `GIT_TOKEN__<PROVIDER>_*`
 * candidate matches a repo's provider. Returns the chosen var name, or
 * undefined when the builder cancels or the run is non-interactive.
 * apply injects a TTY implementation; tests inject a stub.
 */
export type TokenPrompt = (ctx: {
  provider: 'github' | 'gitlab';
  host: string;
  candidates: GitTokenChoice[];
}) => Promise<string | undefined>;

export interface AddedCliFeature {
  /** Feature display name (`github` / `gitlab`). */
  name: string;
  provider: 'github' | 'gitlab';
  host: string;
  /** True when a usable token was set as the feature's `apiToken`. */
  authenticated: boolean;
  /**
   * Why not authenticated (only when `authenticated` is false):
   *   - `no-token`: no `GIT_TOKEN__<PROVIDER>_*` candidate.
   *   - `needs-pick`: several candidates, none chosen (cancelled or
   *     non-interactive).
   *   - `enterprise-unsupported`: a token exists but the host is a
   *     self-hosted GitHub Enterprise Server, which gh can't use a token
   *     env for (needs GH_ENTERPRISE_TOKEN; manual `gh auth login`).
   */
  reason?: 'no-token' | 'needs-pick' | 'enterprise-unsupported';
}

export interface RepoCliResult {
  /** One entry per CLI feature auto-added this run. */
  added: AddedCliFeature[];
  /**
   * host → resolved token VALUE, for the git-credentials write (clone /
   * push). Derived from each provider feature's resolved `apiToken`.
   */
  hostTokens: Record<string, string>;
  /**
   * Feature entries to persist into the yml (ref + options, where
   * `apiToken` is the `${VAR}` reference, not the value), so a re-apply
   * never re-derives or re-prompts. The caller writes these to the yml.
   */
  persist: Array<{ ref: string; options: FeatureOptions }>;
}

/**
 * Default interactive picker: a `consola` select over the candidate
 * labels. Returns undefined in non-interactive runs so apply never hangs.
 */
export const realTokenPrompt: TokenPrompt = async ({
  provider,
  host,
  candidates,
}) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const choice = await consola.prompt(
    `Multiple ${provider} tokens found - which one for ${host}?`,
    {
      type: 'select',
      options: candidates.map((c) => ({ label: c.label, value: c.varName })),
    },
  );
  return typeof choice === 'string' ? choice : undefined;
};

/**
 * Hosts where gh's `GH_TOKEN` authenticates: github.com and Enterprise
 * Cloud (`*.ghe.com`). Self-hosted GitHub Enterprise Server needs
 * `GH_ENTERPRISE_TOKEN` + `GH_HOST`, which the feature does not wire yet,
 * so a token can't auto-authenticate it.
 */
function githubTokenWorks(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'github.com' || h.endsWith('.ghe.com');
}

/**
 * Repo-driven (ADR 0031): scan the configured repos, derive each repo's
 * provider → CLI feature (github-cli / gitlab-cli), and resolve that
 * feature's token from the env. The token lives in the feature's
 * `apiToken`; git-credentials reads the same resolved value (see
 * `hostTokens`). The repo is the driver, the feature the carrier — which
 * leaves a clean spot for featureless providers (Bitbucket) later.
 *
 * Resolution per provider, when its CLI feature isn't already declared:
 *   - exactly one `GIT_TOKEN__<PROVIDER>_*` candidate → used.
 *   - several → `prompt` picks one (undefined when cancelled / headless).
 *   - none → feature added unauthenticated, caller hints how to set one.
 * A token chosen here is returned in `persist` for the caller to write
 * into the yml. An already-declared feature is left untouched but still
 * contributes its resolved `apiToken` to `hostTokens`.
 *
 * Scope: GitHub + GitLab. Self-hosted GitHub Enterprise Server is reported
 * `enterprise-unsupported` (manual `gh auth login --hostname`).
 */
export async function autoAddRepoCliFeatures(
  createOpts: CreateOptions,
  envVars: Record<string, string>,
  prompt: TokenPrompt,
): Promise<RepoCliResult> {
  const empty: RepoCliResult = { added: [], hostTokens: {}, persist: [] };
  const repos = createOpts.repos ?? [];
  if (repos.length === 0) return empty;

  const hostProviders = uniqueHttpsHosts(repos);
  const catalog = await loadComponentCatalog();
  const features = (createOpts.features ??= {});
  const result: RepoCliResult = { added: [], hostTokens: {}, persist: [] };

  for (const provider of ['github', 'gitlab'] as const) {
    const hosts = hostProviders
      .filter((h) => h.provider === provider)
      .map((h) => h.host);
    if (hosts.length === 0) continue;

    const component = catalog.get(provider);
    const ref = component?.file.contributes.features?.[0]?.ref;
    if (!ref) continue; // catalog without the CLI feature: nothing to add

    // Already declared (by the builder, or persisted by a previous apply):
    // don't re-add or prompt, but feed its resolved token to the clone.
    const existing = features[ref];
    if (existing) {
      const token =
        typeof existing.apiToken === 'string' ? existing.apiToken : '';
      if (token) for (const h of hosts) result.hostTokens[h] = token;
      continue;
    }

    const host = hosts[0]!;
    const candidates = gitTokensForProvider(envVars, provider);
    let chosenVar: string | undefined;
    if (candidates.length === 1) {
      chosenVar = candidates[0]!.varName;
    } else if (candidates.length > 1) {
      chosenVar = await prompt({ provider, host, candidates });
    }
    const tokenValue = chosenVar ? (envVars[chosenVar] ?? '') : '';
    const usable = provider === 'gitlab' || githubTokenWorks(host);

    const options: FeatureOptions = {};
    // glab targets gitlab.com unless `host` is set; point it at a
    // self-managed host so commands (and a manual `glab auth login`) use it.
    if (provider === 'gitlab' && host.toLowerCase() !== 'gitlab.com') {
      options.host = host;
    }

    let authenticated = false;
    let reason: AddedCliFeature['reason'];
    if (tokenValue && usable) {
      options.apiToken = tokenValue;
      authenticated = true;
      // Persist the ${VAR} reference (not the value) so the yml stays
      // secret-free; carry gitlab's host so a re-apply reconstructs it.
      const persistOptions: FeatureOptions = { apiToken: `\${${chosenVar}}` };
      if (typeof options.host === 'string') persistOptions.host = options.host;
      result.persist.push({ ref, options: persistOptions });
      for (const h of hosts) result.hostTokens[h] = tokenValue;
    } else if (tokenValue && !usable) {
      reason = 'enterprise-unsupported';
    } else if (candidates.length > 1) {
      reason = 'needs-pick';
    } else {
      reason = 'no-token';
    }

    features[ref] = options;
    result.added.push({
      name: component!.name,
      provider,
      host,
      authenticated,
      ...(reason ? { reason } : {}),
    });
  }

  return result;
}
