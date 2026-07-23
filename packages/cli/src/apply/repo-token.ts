import { promises as fs } from 'node:fs';
import {
  PROVIDER_LABEL,
  PROVIDER_VALUES,
  REPO_DOCS_URL,
  type RepoProvider,
  type SolutionConfig,
} from '../config/schema.js';
import { parseConfig } from '../config/io.js';
import { readEnvFile, mergeEnvLayers } from '../config/env-file.js';
import {
  containerConfigPath,
  containerEnvPath,
  globalEnvPath,
} from '../config/paths.js';
import { resolveProvider } from '../devcontainer/credentials.js';
import { bold, cyan, yellow } from '../util/format.js';
import type { Component } from './../init/components.js';

/**
 * Repo access-token resolution (ADR 0031, ADR 0035). Pure convention, no
 * prompting and no yml mutation. Each provider declares a token
 * {@link ProviderTokenStrategy}: the ordered env vars to try for a repo,
 * and whether the resolved token is also injected into a CLI feature.
 *
 *   - github / gitlab: the `GIT_TOKEN__…` cascade (provider `P`, first URL
 *     path segment `S`): `<P>_API_TOKEN` → `GIT_TOKEN__<P>_<S>` →
 *     `GIT_TOKEN__<P>`. The token is injected into the provider's CLI
 *     feature (so in-container `gh`/`glab` authenticate) AND returned per
 *     host for git-credentials.
 *   - bitbucket: fronted by the Atlassian feature (twg is the Bitbucket
 *     CLI), so the clone token is the Atlassian API token —
 *     `ATLASSIAN_BITBUCKET_TOKEN` (which the sample defaults to
 *     `${ATLASSIAN_API_TOKEN}`). No feature injection: the Atlassian
 *     feature authenticates twg off its own env options.
 *
 * A repo with no resolvable token lands in `missing`; a missing token is
 * non-fatal (public repos clone read-only), surfaced as an end-of-apply
 * warning. Which var supplied each token is reported in `used`.
 */

type Feature = {
  ref: string;
  options?: Record<string, string | number | boolean>;
};

export interface RepoTokenUse {
  host: string;
  provider: RepoProvider;
  /** The env var the token was read from. */
  varName: string;
  /**
   * What the token authenticates: a declared `repo` (clone/push), or a
   * provider CLI `feature` with no repo (just `gh`/`glab` login). Drives
   * the log wording so a repo-less container never reads "Repo token".
   */
  source: 'repo' | 'feature';
}

export interface MissingRepoToken {
  host: string;
  provider: RepoProvider;
  /** Env vars that were checked, in cascade order — named in the error. */
  tried: string[];
}

/**
 * A provider CLI feature with NO repo to key a token off, where the env
 * offers several `GIT_TOKEN__<PROVIDER>_*` candidates — genuinely
 * ambiguous, so the builder must pick (apply prompts, then remembers the
 * choice as a `<name>.env` reference). ADR 0031.
 */
export interface AmbiguousFeatureToken {
  provider: RepoProvider;
  featureRef: string;
  /** Canonical host the token authenticates (github.com / gitlab.com). */
  host: string;
  /** The `GIT_TOKEN__<PROVIDER>_*` vars to choose among. */
  candidates: string[];
}

/**
 * Interactive pick for an {@link AmbiguousFeatureToken} — returns the
 * chosen `GIT_TOKEN__<PROVIDER>_*` var, or null to leave the feature
 * unauthenticated. Injectable so tests drive it without a TTY.
 */
export type FeatureTokenPrompt = (
  ctx: AmbiguousFeatureToken,
) => Promise<string | null>;

export interface RepoTokenResult {
  /** Features with the resolved token injected into the provider CLI feature. */
  features: SolutionConfig['features'];
  /** host → token, for the git-credentials writer. */
  hostTokens: Map<string, string>;
  /** Which env var supplied each repo's token (for logging). */
  used: RepoTokenUse[];
  /** Repos whose token couldn't be resolved. */
  missing: MissingRepoToken[];
  /** Repo-less provider features needing an interactive pick (apply resolves). */
  ambiguous: AmbiguousFeatureToken[];
}

/** The host a provider's token authenticates when there's no repo URL. */
const CANONICAL_HOST: Record<RepoProvider, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  bitbucket: 'bitbucket.org',
};

/** The `<S>` segment for `GIT_TOKEN__<P>_<S>` — the URL's first path part. */
function workspaceSegment(url: string): string | undefined {
  let ws: string | undefined;
  try {
    ws = new URL(url).pathname.split('/').filter(Boolean)[0];
  } catch {
    return undefined;
  }
  return ws ? ws.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase() : undefined;
}

/**
 * How one provider resolves a repo's access token. Adding a provider is a
 * new row here, not a change to the resolution loop (ADR 0035). The table
 * governs token resolution only — host detection, git username and
 * provider mapping stay their own tables in `config/schema.ts`.
 */
interface ProviderTokenStrategy {
  /** Env vars to try for a repo URL, in order. First non-empty wins. */
  candidates(url: string): string[];
  /**
   * Inject the resolved token into the provider's contributed CLI feature
   * as its `apiToken` option, and let the provider take part in the
   * repo-less feature-token loop (a CLI feature present without a repo).
   * false for bitbucket: the Atlassian feature authenticates twg off its
   * own env options, so repo-token never touches it.
   */
  injectFeature: boolean;
}

/**
 * The github/gitlab cascade: `<P>_API_TOKEN` → `GIT_TOKEN__<P>_<SEGMENT>`
 * → `GIT_TOKEN__<P>`. The first doubles as the CLI-feature placeholder.
 */
function gitTokenCascade(provider: RepoProvider, url: string): string[] {
  const p = provider.toUpperCase();
  const vars: string[] = [`${p}_API_TOKEN`];
  const segment = workspaceSegment(url);
  if (segment) vars.push(`GIT_TOKEN__${p}_${segment}`);
  vars.push(`GIT_TOKEN__${p}`);
  return vars;
}

const PROVIDER_TOKEN_STRATEGY: Record<RepoProvider, ProviderTokenStrategy> = {
  github: {
    candidates: (url) => gitTokenCascade('github', url),
    injectFeature: true,
  },
  gitlab: {
    candidates: (url) => gitTokenCascade('gitlab', url),
    injectFeature: true,
  },
  // Bitbucket auth is the user-scoped Atlassian token. No URL-segment
  // keying (one token covers every workspace); the ATLASSIAN_API_TOKEN
  // fall-through is the declarative sample default, not a code candidate.
  bitbucket: {
    candidates: () => ['ATLASSIAN_BITBUCKET_TOKEN'],
    injectFeature: false,
  },
};

export function resolveRepoTokens(
  config: SolutionConfig,
  catalog: Map<string, Component>,
  envVars: Record<string, string>,
): RepoTokenResult {
  const features: Feature[] = config.features.map((f) => ({
    ...f,
    ...(f.options ? { options: { ...f.options } } : {}),
  }));
  const hostTokens = new Map<string, string>();
  const used: RepoTokenUse[] = [];
  const missing: MissingRepoToken[] = [];
  const ambiguous: AmbiguousFeatureToken[] = [];
  const providersWithRepo = new Set<RepoProvider>();

  // Inject a resolved token into a provider's CLI feature so the
  // in-container gh/glab is authenticated (no-op for featureless providers).
  const injectFeatureToken = (ref: string | undefined, token: string): void => {
    if (!ref) return;
    const feature = features.find((f) => f.ref === ref);
    if (feature) feature.options = { ...feature.options, apiToken: token };
  };

  for (const repo of config.repos ?? []) {
    if (!repo.url.startsWith('https://')) continue; // only HTTPS is cloned
    let host: string;
    try {
      host = new URL(repo.url).hostname;
    } catch {
      continue;
    }
    const provider = resolveProvider(host, repo.provider);
    // Unknown providers are rejected by the separate "set provider:"
    // pre-flight; skip them here so they don't show as missing tokens.
    if (provider === 'unknown') continue;
    providersWithRepo.add(provider);

    const strategy = PROVIDER_TOKEN_STRATEGY[provider];
    const ref = catalog.get(provider)?.file.contributes.features?.[0]?.ref;
    const tried = strategy.candidates(repo.url);
    const hit = tried.find((v) => (envVars[v] ?? '').trim().length > 0);
    if (!hit) {
      missing.push({ host, provider, tried });
      continue;
    }
    const token = envVars[hit]!.trim();
    hostTokens.set(host, token);
    used.push({ host, provider, varName: hit, source: 'repo' });
    if (strategy.injectFeature) injectFeatureToken(ref, token);
  }

  // Provider CLI features present WITHOUT a repo (ADR 0031): no URL to
  // key an org off, so the cascade drops the segment layer —
  // `<P>_API_TOKEN` → `GIT_TOKEN__<P>`. Exactly one org-keyed token is
  // used automatically; several are genuinely ambiguous (the builder
  // picks at apply). The resolved token authenticates the feature AND
  // seeds git-credentials for the provider's canonical host. Only
  // providers whose strategy injects a feature token take part — bitbucket
  // (Atlassian-fronted) authenticates twg off its own env, not here.
  for (const provider of PROVIDER_VALUES) {
    if (providersWithRepo.has(provider)) continue;
    if (!PROVIDER_TOKEN_STRATEGY[provider].injectFeature) continue;
    const ref = catalog.get(provider)?.file.contributes.features?.[0]?.ref;
    if (!ref || !config.features.some((f) => f.ref === ref)) continue;

    const p = provider.toUpperCase();
    const host = CANONICAL_HOST[provider];
    const direct = [`${p}_API_TOKEN`, `GIT_TOKEN__${p}`].find(
      (v) => (envVars[v] ?? '').trim().length > 0,
    );
    if (direct) {
      const token = envVars[direct]!.trim();
      hostTokens.set(host, token);
      used.push({ host, provider, varName: direct, source: 'feature' });
      injectFeatureToken(ref, token);
      continue;
    }
    const orgVars = Object.keys(envVars)
      .filter((k) => k.startsWith(`GIT_TOKEN__${p}_`) && envVars[k]!.trim())
      .sort();
    if (orgVars.length === 1) {
      const token = envVars[orgVars[0]!]!.trim();
      hostTokens.set(host, token);
      used.push({ host, provider, varName: orgVars[0]!, source: 'feature' });
      injectFeatureToken(ref, token);
    } else if (orgVars.length > 1) {
      ambiguous.push({ provider, featureRef: ref, host, candidates: orgVars });
    } else {
      missing.push({
        host,
        provider,
        tried: [`${p}_API_TOKEN`, `GIT_TOKEN__${p}`],
      });
    }
  }

  return {
    features: features as SolutionConfig['features'],
    hostTokens,
    used,
    missing,
    ambiguous,
  };
}

/** Resolve repo tokens for a container by name (reads yml + merged env). */
export async function resolveContainerRepoTokens(
  name: string,
  home: string,
  catalog: Map<string, Component>,
): Promise<RepoTokenResult> {
  const ymlPath = containerConfigPath(name, home);
  const { config } = parseConfig(await fs.readFile(ymlPath, 'utf8'), ymlPath);
  const envVars = mergeEnvLayers(
    readEnvFile(globalEnvPath(home)),
    readEnvFile(containerEnvPath(name, home)),
  );
  return resolveRepoTokens(config, catalog, envVars);
}

/**
 * One log line naming the env var a token was read from and what it
 * authenticates — the CLI for a repo-less provider feature (`gh`/`glab`
 * login), or the host for a declared repo (clone/push).
 */
export function formatTokenUse(use: RepoTokenUse): string {
  return use.source === 'feature'
    ? `Using ${use.varName} for the ${PROVIDER_LABEL[use.provider]} CLI`
    : `Using ${use.varName} for ${use.host}`;
}

/**
 * Shared heading for the end-of-apply repo warning blocks (the token
 * warning and the failed-clone warning) so both render as the same kind
 * of block. Bold-yellow so it stands out from the grey status output; in
 * a non-TTY (piped / log file) the palette no-ops to plain text.
 */
function warnBlockHeading(title: string): string[] {
  return [bold(yellow(`⚠  ${title}`)), ''];
}

/** Shared footer pointing at the repo-access docs. */
function detailsFooter(): string {
  return `   Details: ${cyan(REPO_DOCS_URL)}`;
}

/**
 * Prominent end-of-apply warning for repos left without a token. A
 * missing token is non-fatal (public repos clone read-only), but gh/glab
 * and any write/private operation won't work — so this states the
 * consequences and names the vars + files to set, per provider.
 */
export function formatUnauthenticatedRepos(
  missing: readonly MissingRepoToken[],
  containerName: string,
): string {
  const lines: string[] = [
    ...warnBlockHeading('Repo access — action needed'),
    yellow('   Some repositories are UNAUTHENTICATED:'),
  ];
  for (const m of missing) {
    lines.push(`     • ${PROVIDER_LABEL[m.provider]} (${m.host})`);
  }
  lines.push(
    '',
    bold('   Public repositories still clone (read-only). But:'),
    '     • gh / glab in the container are not logged in.',
    '     • pushing, and cloning/pulling PRIVATE repositories, fails.',
    '     • branches, PRs/MRs — anything that writes to the remote — fails.',
    '',
    bold('   Set a token, then re-apply:'),
  );
  for (const m of missing) {
    const sharedVar = m.tried.find((v) => v.startsWith('GIT_TOKEN__'));
    if (sharedVar) {
      // github/gitlab cascade: [<P>_API_TOKEN, GIT_TOKEN__<P>_<SEG>, GIT_TOKEN__<P>].
      const featureVar = m.tried.find((v) => !v.startsWith('GIT_TOKEN__'))!;
      lines.push(
        `     • ${PROVIDER_LABEL[m.provider]}: ${cyan(featureVar)} in container-configs/${containerName}.env,`,
        `       or ${cyan(sharedVar)} in monoceros-config.env`,
      );
    } else {
      // bitbucket: a single Atlassian var, valid in either env layer.
      const tokenVar = m.tried[0]!;
      lines.push(
        `     • ${PROVIDER_LABEL[m.provider]}: ${cyan(tokenVar)} in container-configs/${containerName}.env`,
        `       or monoceros-config.env (defaults to ${cyan('ATLASSIAN_API_TOKEN')}).`,
      );
    }
  }
  lines.push('', detailsFooter());
  return lines.join('\n');
}

/** A repo declared in the yml that did not clone (its checkout is absent). */
export interface FailedCloneRepo {
  /** `projects/<path>` that did not materialize. */
  path: string;
  /** The declared clone URL, for the message. */
  url: string;
}

/**
 * End-of-apply warning for repos declared but NOT cloned — detected after
 * the container is up by the absence of their `projects/<path>` checkout
 * (the in-container clone soft-fails and cleans up any partial checkout,
 * and the workspace is bind-mounted, so a missing dir is ground truth).
 *
 * Sibling of {@link formatUnauthenticatedRepos}: same block shape, later
 * moment (post-clone, not token-resolution), different cause. A failed
 * clone is non-fatal — apply still brings the container up — so this names
 * what is missing and the most common fix rather than claiming success in
 * the summary.
 */
export function formatFailedClones(
  failed: readonly FailedCloneRepo[],
  containerName: string,
): string {
  const lines: string[] = [
    ...warnBlockHeading('Repositories not cloned'),
    yellow('   Declared, but no checkout after apply:'),
  ];
  for (const f of failed) {
    lines.push(`     • ${f.path}  (${f.url})`);
  }
  lines.push(
    '',
    bold('   The container is up; these checkouts are simply absent.'),
    '   Most often a private repo whose token is missing or lacks the',
    '   required scopes — the exact clone error is in the apply log. Set',
    `   the token in container-configs/${containerName}.env (or`,
    '   monoceros-config.env), then re-apply.',
    '',
    detailsFooter(),
  );
  return lines.join('\n');
}
