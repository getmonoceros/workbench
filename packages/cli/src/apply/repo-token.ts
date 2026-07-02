import { promises as fs } from 'node:fs';
import {
  PROVIDER_LABEL,
  PROVIDER_VALUES,
  REPO_DOCS_URL,
  type RepoProvider,
  type SolutionConfig,
} from '../config/schema.js';
import { parseConfig } from '../config/io.js';
import { readEnvFile } from '../config/env-file.js';
import {
  containerConfigPath,
  containerEnvPath,
  globalEnvPath,
} from '../config/paths.js';
import { resolveProvider } from '../devcontainer/credentials.js';
import { bold, cyan, yellow } from '../util/format.js';
import type { Component } from './../init/components.js';

/**
 * Repo access-token resolution (ADR 0031). Pure convention, no prompting
 * and no yml mutation. Per declared repo, the token is resolved from the
 * merged env by this cascade (provider `P`, first URL path segment `S`):
 *
 *   1. `<P>_API_TOKEN`            — the feature placeholder; the builder's
 *                                   explicit per-container/global override.
 *                                   Only for providers with a CLI feature.
 *   2. `GIT_TOKEN__<P>_<S>`       — keyed by the first path segment
 *                                   (github owner / gitlab group / bitbucket
 *                                   workspace), uppercased, non-alnum → `_`.
 *   3. `GIT_TOKEN__<P>`           — provider-wide catch-all.
 *
 * The resolved token is injected into the provider CLI feature (so the
 * in-container `gh`/`glab` is authenticated) and returned per host for the
 * git-credentials writer (so the clone/push authenticates). A repo with no
 * resolvable token lands in `missing` so apply can abort with a clear hint.
 * Which var supplied each token is reported in `used` for logging.
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
 * The env vars to try for a repo, in cascade order — the same three
 * shapes for every provider:
 *   `<P>_API_TOKEN` → `GIT_TOKEN__<P>_<SEGMENT>` → `GIT_TOKEN__<P>`.
 * For github/gitlab the first also happens to be the feature placeholder
 * (see PROVIDER_TOKEN_VAR); for bitbucket it's just the per-container
 * override. Uniform so every provider reads and errors the same way.
 */
function tokenVarCandidates(provider: RepoProvider, url: string): string[] {
  const p = provider.toUpperCase();
  const vars: string[] = [`${p}_API_TOKEN`];
  const segment = workspaceSegment(url);
  if (segment) vars.push(`GIT_TOKEN__${p}_${segment}`);
  vars.push(`GIT_TOKEN__${p}`);
  return vars;
}

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

    const ref = catalog.get(provider)?.file.contributes.features?.[0]?.ref;
    const tried = tokenVarCandidates(provider, repo.url);
    const hit = tried.find((v) => (envVars[v] ?? '').trim().length > 0);
    if (!hit) {
      missing.push({ host, provider, tried });
      continue;
    }
    const token = envVars[hit]!.trim();
    hostTokens.set(host, token);
    used.push({ host, provider, varName: hit, source: 'repo' });
    injectFeatureToken(ref, token);
  }

  // Provider CLI features present WITHOUT a repo (ADR 0031): no URL to
  // key an org off, so the cascade drops the segment layer —
  // `<P>_API_TOKEN` → `GIT_TOKEN__<P>`. Exactly one org-keyed token is
  // used automatically; several are genuinely ambiguous (the builder
  // picks at apply). The resolved token authenticates the feature AND
  // seeds git-credentials for the provider's canonical host.
  for (const provider of PROVIDER_VALUES) {
    if (providersWithRepo.has(provider)) continue;
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
  const envVars = {
    ...readEnvFile(globalEnvPath(home)),
    ...readEnvFile(containerEnvPath(name, home)),
  };
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
 * Prominent end-of-apply warning for repos left without a token. A
 * missing token is non-fatal (public repos clone read-only), but gh/glab
 * and any write/private operation won't work — so this states the
 * consequences and names the vars + files to set, per provider.
 */
export function formatUnauthenticatedRepos(
  missing: readonly MissingRepoToken[],
  containerName: string,
): string {
  // Own heading + colour so it stands out from the grey status output —
  // yellow/bold heading, cyan var names (the "you set this" colour). In a
  // non-TTY (piped / log file) the palette no-ops to plain text.
  const lines: string[] = [
    bold(yellow('⚠  Repo access — action needed')),
    '',
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
    // tried order: [<PROVIDER>_API_TOKEN, GIT_TOKEN__<P>_<SEG>, GIT_TOKEN__<P>].
    const featureVar = m.tried.find((v) => !v.startsWith('GIT_TOKEN__'))!;
    const sharedVar = m.tried.find((v) => v.startsWith('GIT_TOKEN__'))!;
    lines.push(
      `     • ${PROVIDER_LABEL[m.provider]}: ${cyan(featureVar)} in container-configs/${containerName}.env,`,
      `       or ${cyan(sharedVar)} in monoceros-config.env`,
    );
  }
  lines.push('', `   Details: ${cyan(REPO_DOCS_URL)}`);
  return lines.join('\n');
}
