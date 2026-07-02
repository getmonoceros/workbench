import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoEntry } from '../create/types.js';
import {
  GIT_CREDENTIAL_USERNAME,
  KNOWN_PROVIDER_HOSTS,
  type RepoProvider,
} from '../config/schema.js';
import { cyan } from '../util/format.js';

// Repo authentication is PAT-only (ADR 0031): the token configured for a
// provider is written into `.monoceros/git-credentials`, which the
// in-container `git clone`/push reads via its `store` credential helper.
// The host's own git credential helper (keychain / GCM / gh / glab) is
// deliberately NOT consulted — the host needs no git tooling, and there
// is a single, explicit source of truth for repo credentials.

/**
 * Resolve a host's provider:
 *   - canonical hosts (github.com / gitlab.com / bitbucket.org) →
 *     their fixed provider, ignoring any explicit hint (the canonical
 *     mapping is the source of truth)
 *   - any other host → the explicit hint if given, else 'unknown'
 *
 * Returning 'unknown' triggers the apply pre-flight error that asks
 * the builder to set `provider:` in the yml. We deliberately never
 * guess from hostname patterns ("starts with `gitlab.`" etc.) —
 * those produced wrong results for corporate domains like
 * `git.firma.de` and silently fell through to the generic hint.
 */
export type ResolvedProvider = RepoProvider | 'unknown';

export function resolveProvider(
  host: string,
  explicit?: RepoProvider,
): ResolvedProvider {
  const canonical = KNOWN_PROVIDER_HOSTS[host.toLowerCase()];
  if (canonical) return canonical;
  return explicit ?? 'unknown';
}

export interface HostWithProvider {
  host: string;
  provider: ResolvedProvider;
}

/**
 * Reduce a repo list to one entry per host, carrying along the
 * resolved provider so the pre-flight check can render the right
 * setup hint (or error out with "set provider:" for unknowns).
 *
 * If the same host appears with conflicting provider declarations
 * across multiple repo entries, the first one wins — the apply
 * pre-flight surfaces the conflict as a separate diagnostic before
 * we get here in normal flow. (Schema-level dedup would lock us in
 * before the builder ever sees the warning.)
 */
function uniqueHttpsHosts(repos: readonly RepoEntry[]): HostWithProvider[] {
  const byHost = new Map<string, HostWithProvider>();
  for (const repo of repos) {
    if (!repo.url.startsWith('https://')) continue;
    let host: string;
    try {
      host = new URL(repo.url).hostname;
    } catch {
      // Skip malformed URLs — validateOptions catches them at the
      // add-repo step, so reaching this in production means a stack
      // file was hand-edited. Don't fail the whole apply for it.
      continue;
    }
    if (byHost.has(host)) continue;
    byHost.set(host, { host, provider: resolveProvider(host, repo.provider) });
  }
  return [...byHost.values()];
}

function formatCredentialLine(
  host: string,
  username: string,
  password: string,
): string {
  // Both fields percent-encoded so a `@`, `:`, or `/` in the token
  // doesn't break URL parsing inside git's `store` helper.
  const encUser = encodeURIComponent(username);
  const encPass = encodeURIComponent(password);
  return `https://${encUser}:${encPass}@${host}`;
}

export interface CollectCredentialsOptions {
  /**
   * Configured personal access tokens per host (ADR 0031). Written with
   * the provider's git username (`GIT_CREDENTIAL_USERNAME`) and the token
   * as the password. A host with no entry gets no line and is reported
   * `no-token` so the caller can fail with an actionable hint.
   */
  patByHost?: ReadonlyMap<string, string>;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface HostCredentialStatus {
  host: string;
  /** Resolved provider for this host (carried into the failure message). */
  provider: RepoProvider;
  /** 'ok' when a configured token was written; 'no-token' otherwise. */
  status: 'ok' | 'no-token';
  /** Diagnostic text — empty when status is 'ok'. */
  detail: string;
}

export interface CollectCredentialsResult {
  /** Hosts for which a token line was written. */
  hostsWritten: number;
  /** Hosts with no configured token. */
  hostsSkipped: number;
  /** Per-host status (in input order). */
  perHost: HostCredentialStatus[];
  /** Absolute path to the written credentials file (always written, possibly empty). */
  credentialsPath: string;
}

/**
 * Write the configured provider tokens for the dev-container's repo
 * hosts into `<devContainerRoot>/.monoceros/git-credentials`, which the
 * in-container `git clone`/push reads via its `store` credential helper
 * (ADR 0031). PAT-only: the host's own git credential helper is never
 * consulted, so the host needs no git tooling.
 *
 * Always writes the file (possibly empty) so the bind-mount target
 * exists in the container. A host with no configured token is reported
 * `no-token` so the caller fails the apply with a "set a token" hint
 * rather than starting a container that can't reach its private repos.
 */
export async function collectGitCredentials(
  devContainerRoot: string,
  hosts: readonly HostWithProvider[],
  options: CollectCredentialsOptions = {},
): Promise<CollectCredentialsResult> {
  const credsDir = path.join(devContainerRoot, '.monoceros');
  const credentialsPath = path.join(credsDir, 'git-credentials');

  const lines: string[] = [];
  const perHost: HostCredentialStatus[] = [];
  for (const { host, provider } of hosts) {
    // Callers reject 'unknown' providers before this (a "set provider:"
    // pre-flight error). Treat any that slip through as no-token.
    const known: RepoProvider = provider === 'unknown' ? 'github' : provider;
    const pat = options.patByHost?.get(host);
    if (pat) {
      lines.push(
        formatCredentialLine(host, GIT_CREDENTIAL_USERNAME[known], pat),
      );
      perHost.push({ host, provider: known, status: 'ok', detail: '' });
    } else {
      perHost.push({
        host,
        provider: known,
        status: 'no-token',
        detail: 'no personal access token configured',
      });
    }
  }

  await fs.mkdir(credsDir, { recursive: true });
  await fs.writeFile(
    credentialsPath,
    lines.join('\n') + (lines.length > 0 ? '\n' : ''),
    { mode: 0o600 },
  );

  return {
    hostsWritten: lines.length,
    hostsSkipped: perHost.filter((p) => p.status !== 'ok').length,
    perHost,
    credentialsPath,
  };
}

/**
 * Expose `uniqueHttpsHosts` for callers that need the host list
 * directly (apply uses it to build the pre-flight check input).
 */
export { uniqueHttpsHosts };

/**
 * Build the pre-flight error for repos whose host has no provider
 * declared and isn't one of the canonical ones (github.com /
 * gitlab.com / bitbucket.org). The builder needs to add a
 * `provider:` field to the yml before apply can continue.
 */
export function formatUnknownProviderError(hosts: readonly string[]): string {
  const sorted = [...new Set(hosts)].sort();
  const lines: string[] = [
    sorted.length === 1
      ? `Unknown Git provider for host ${sorted[0]!}.`
      : `Unknown Git provider for ${sorted.length} hosts: ${sorted.join(', ')}.`,
    '',
    'Monoceros auto-detects only github.com / gitlab.com / bitbucket.org.',
    'For any other host (self-hosted GitLab, GitHub Enterprise, Bitbucket',
    'Data Center) declare the provider explicitly in the yml. Edit the',
    'repo entry:',
    '',
    cyan('  repos:'),
    cyan(`    - url: https://${sorted[0]!}/…`),
    cyan('      provider: gitlab   # or: github, bitbucket'),
    '',
    `Or re-add with ${cyan('monoceros add-repo <name> <url> --provider=<github|gitlab|bitbucket>')}.`,
  ];
  return lines.join('\n');
}

// Exported for tests.
export const _internals = {
  uniqueHttpsHosts,
  formatCredentialLine,
};
