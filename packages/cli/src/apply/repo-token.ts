import { promises as fs } from 'node:fs';
import {
  PROVIDER_LABEL,
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
}

export interface MissingRepoToken {
  host: string;
  provider: RepoProvider;
  /** Env vars that were checked, in cascade order — named in the error. */
  tried: string[];
}

export interface RepoTokenResult {
  /** Features with the resolved token injected into the provider CLI feature. */
  features: SolutionConfig['features'];
  /** host → token, for the git-credentials writer. */
  hostTokens: Map<string, string>;
  /** Which env var supplied each repo's token (for logging). */
  used: RepoTokenUse[];
  /** Repos whose token couldn't be resolved. */
  missing: MissingRepoToken[];
}

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

    const ref = catalog.get(provider)?.file.contributes.features?.[0]?.ref;
    const tried = tokenVarCandidates(provider, repo.url);
    const hit = tried.find((v) => (envVars[v] ?? '').trim().length > 0);
    if (!hit) {
      missing.push({ host, provider, tried });
      continue;
    }
    const token = envVars[hit]!.trim();
    hostTokens.set(host, token);
    used.push({ host, provider, varName: hit });
    // Inject into the provider CLI feature so the in-container gh/glab is
    // authenticated — even when the token came from a GIT_TOKEN__ var
    // rather than the feature's own placeholder.
    if (ref) {
      const feature = features.find((f) => f.ref === ref);
      if (feature) feature.options = { ...feature.options, apiToken: token };
    }
  }

  return {
    features: features as SolutionConfig['features'],
    hostTokens,
    used,
    missing,
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

/** One log line naming the env var a repo's token was read from. */
export function formatTokenUse(use: RepoTokenUse): string {
  return `${PROVIDER_LABEL[use.provider]} (${use.host}) → ${use.varName}`;
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
