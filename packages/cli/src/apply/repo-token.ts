import { promises as fs } from 'node:fs';
import { consola } from 'consola';
import type { RepoProvider, SolutionConfig } from '../config/schema.js';
import { parseConfig, stringifyConfig } from '../config/io.js';
import { interpolate } from '../config/env-file.js';
import { globalEnvPath, prettyPath } from '../config/paths.js';
import { resolveProvider } from '../devcontainer/credentials.js';
import type { Component } from './../init/components.js';
import { setFeatureApiTokenInDoc } from '../modify/yml.js';

/**
 * Repo-driven token binding at apply time (ADR 0031).
 *
 * The provider CLI feature (github-cli / gitlab-cli) was added to the
 * yml by add-repo / init when the repo was declared. Its `apiToken`
 * option carries the standard placeholder (`${GITHUB_CLI_API_TOKEN}`).
 * When that placeholder resolves EMPTY against the env, apply offers the
 * builder's `GIT_TOKEN__<PROVIDER>_<LABEL>` vars from the (merged) env as
 * a pick list and rewrites the feature's placeholder to the chosen var —
 * so a shared PAT in `monoceros-config.env` binds to the container
 * without the builder editing the yml by hand.
 *
 * Aborts the apply (throws) when the token is empty and there is no
 * candidate var, or when the builder cancels the pick.
 */

/**
 * Interactive pick of which env var to bind to a provider's CLI feature.
 * Returns the chosen VAR name, or null when the builder cancels.
 * Injectable so tests drive it without a TTY.
 */
export type TokenPrompt = (ctx: {
  provider: RepoProvider;
  candidates: string[];
}) => Promise<string | null>;

// Sentinel value for the "abort" entry in the select list. Never collides
// with a candidate — those are all `GIT_TOKEN__<PROVIDER>_…` names.
const CANCEL = 'cancel';

const realTokenPrompt: TokenPrompt = async ({ provider, candidates }) => {
  const choice = await consola.prompt(
    `The ${provider} CLI feature has no token set. Pick which token to use for this container:`,
    {
      type: 'select',
      options: [
        ...candidates.map((v) => ({ label: v, value: v })),
        { label: 'Cancel — abort apply', value: CANCEL },
      ],
    },
  );
  if (typeof choice !== 'string' || choice === CANCEL) return null;
  return choice;
};

export interface ResolveRepoTokensDeps {
  /** Absolute path to the source yml — rewritten in place on a pick. */
  ymlPath: string;
  /** User-data home — locates the global env for the abort hint. */
  home: string;
  /** Merged env (global under per-container) the apply resolves against. */
  envVars: Record<string, string>;
  /** Loaded component catalog — maps a provider to its CLI feature ref. */
  catalog: Map<string, Component>;
  /** Override the interactive pick. Tests inject a canned answer. */
  prompt?: TokenPrompt;
  logger: { info: (msg: string) => void; warn?: (msg: string) => void };
}

/**
 * For each declared repo whose provider has a CLI feature present in the
 * yml, ensure the feature's `apiToken` resolves to a non-empty value —
 * picking (and persisting) a `GIT_TOKEN__<PROVIDER>_*` binding when it
 * doesn't. Returns the (possibly rewritten) features for the caller to
 * feed into option interpolation; the yml on disk is updated in place
 * when a binding was chosen.
 */
export async function resolveRepoTokens(
  config: SolutionConfig,
  deps: ResolveRepoTokensDeps,
): Promise<SolutionConfig['features']> {
  const repos = config.repos ?? [];
  if (repos.length === 0) return config.features;

  // Distinct providers needed by the declared repos that (a) resolve to
  // a known provider, (b) have a CLI feature in the catalog, and (c) that
  // feature is actually present in this yml. Featureless providers
  // (bitbucket / gitea) and local paths fall through untouched.
  const needed = new Map<RepoProvider, string>(); // provider → feature ref
  for (const repo of repos) {
    let host: string;
    try {
      host = new URL(repo.url).hostname;
    } catch {
      continue; // not a URL (local path) — no provider token to bind
    }
    const provider = resolveProvider(host, repo.provider);
    if (provider === 'unknown') continue;
    const ref = deps.catalog.get(provider)?.file.contributes.features?.[0]?.ref;
    if (!ref) continue;
    if (!config.features.some((f) => f.ref === ref)) continue;
    needed.set(provider, ref);
  }
  if (needed.size === 0) return config.features;

  const prompt = deps.prompt ?? realTokenPrompt;
  let changed = false;
  // Re-read as a Document so a chosen binding can be written back in place
  // without losing the yml's comments / layout.
  const text = await fs.readFile(deps.ymlPath, 'utf8');
  const parsed = parseConfig(text, deps.ymlPath);

  for (const [provider, ref] of needed) {
    const feature = config.features.find((f) => f.ref === ref)!;
    const raw = feature.options?.apiToken;
    const resolved =
      typeof raw === 'string' ? interpolate(raw, deps.envVars) : undefined;
    const tokenSet =
      resolved !== undefined &&
      resolved.missing.length === 0 &&
      resolved.value.trim().length > 0;
    if (tokenSet) continue;

    const prefix = `GIT_TOKEN__${provider.toUpperCase()}_`;
    const candidates = Object.keys(deps.envVars)
      .filter((k) => k.startsWith(prefix) && deps.envVars[k]!.trim().length > 0)
      .sort();
    if (candidates.length === 0) {
      throw new Error(formatNoTokenError(provider, prefix, deps.home));
    }

    const chosen = await prompt({ provider, candidates });
    if (chosen === null) {
      throw new Error(
        `Apply aborted: no token selected for ${provider}. Set the feature's ` +
          `apiToken in the yml, or pick a ${prefix}… var next time.`,
      );
    }
    if (setFeatureApiTokenInDoc(parsed.doc, ref, `\${${chosen}}`)) {
      changed = true;
      deps.logger.info(
        `Bound the ${provider} CLI token to \${${chosen}} in ${prettyPath(deps.ymlPath)}.`,
      );
    }
  }

  if (!changed) return config.features;
  const out = stringifyConfig(parsed.doc);
  await fs.writeFile(deps.ymlPath, out, 'utf8');
  return parseConfig(out, deps.ymlPath).config.features;
}

function formatNoTokenError(
  provider: RepoProvider,
  prefix: string,
  home: string,
): string {
  return (
    `Apply aborted: a ${provider} repo is declared but the ${provider} CLI ` +
    `feature has no token, and no ${prefix}… entry exists in your global env.\n\n` +
    `Add one to ${prettyPath(globalEnvPath(home))}, e.g.\n` +
    `  ${prefix}MYACCOUNT=<personal-access-token>\n\n` +
    `then re-run apply. (Or set the feature's apiToken in the yml directly.)`
  );
}
