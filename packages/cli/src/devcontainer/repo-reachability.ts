import { spawn } from 'node:child_process';
import { cyan } from '../util/format.js';

/**
 * Apply pre-flight stage 2: after credentials have been collected,
 * verify host-side that each declared repo URL actually resolves and
 * the stored credentials can read from it.
 *
 * The idea: `git ls-remote <url>` is a one-roundtrip probe that
 * exercises exactly the same auth path as the in-container `git clone`
 * would. If it succeeds host-side, the clone inside the container
 * will succeed too (we write the same credentials into
 * `.monoceros/git-credentials`). If it fails — repo doesn't exist,
 * token is wrong, host unreachable — we surface a per-repo error
 * BEFORE the docker build runs, saving 1–2 min of build time on
 * first apply and avoiding a noisy devcontainer-cli stack trace
 * for what's really just a typo in the URL or a missing token scope.
 *
 * This runs AFTER the credential pre-flight (`collectGitCredentials`).
 * Order matters: a missing-creds error wants a provider-specific
 * setup hint (gh / glab / Atlassian token), a present-but-wrong-creds
 * error wants a "regenerate / fix scope" hint. The stage-1 check
 * catches the first; this stage-2 check catches the rest.
 */

/**
 * Spawn signature for `git ls-remote <url>`. Returns stdout+stderr
 * plus exit code. Injected by tests. stdout is empty on success
 * (we don't care about the ref list, just whether the call worked).
 */
export type ReachabilitySpawn = (url: string) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

const realGitLsRemote: ReachabilitySpawn = (url) => {
  return new Promise((resolve, reject) => {
    // GIT_TERMINAL_PROMPT=0 stops `git` itself from prompting on a
    // controlling terminal, which is all we want here — the
    // pre-flight is non-interactive. We DON'T also set
    // GIT_ASKPASS='' or SSH_ASKPASS='': empty string is version-
    // dependently interpreted (some git versions take it as "no
    // askpass", others try to spawn the empty path and fail in
    // weird ways) and, more importantly, it tickles a bug in Git
    // Credential Manager on Windows where `git credential-manager
    // store` after a successful OAuth flow silently no-ops. The
    // credential helper (GCM / gh's helper / Atlassian's) is the
    // right tool for authenticated probes — let it run.
    const child = spawn('git', ['ls-remote', '--heads', '--', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 0 }),
    );
  });
};

/**
 * Categorization of a reachability failure. Drives the per-host hint
 * in the consolidated error message. Patterns were observed across
 * GitHub, GitLab, and Bitbucket Cloud responses to non-existent /
 * unauthorized repos. We err on the side of grouping rather than
 * fine-grained kinds — the actionable advice is largely the same
 * within each kind.
 */
export type ReachabilityFailureKind =
  | 'not-found-or-no-access'
  | 'auth-failed'
  | 'dns'
  | 'unknown';

export interface RepoReachabilityStatus {
  url: string;
  ok: boolean;
  kind?: ReachabilityFailureKind;
  /** Raw stderr from git, trimmed. Empty when ok. */
  detail: string;
}

/**
 * Classify a non-zero `git ls-remote` failure by stderr content.
 * Patterns are matched case-insensitively against the union of
 * substrings each provider tends to emit. Order matters: DNS errors
 * sometimes also produce "Authentication failed" follow-up lines on
 * some platforms, so we check DNS first.
 */
function classifyStderr(stderr: string): ReachabilityFailureKind {
  const s = stderr.toLowerCase();
  if (
    s.includes('could not resolve host') ||
    s.includes('name or service not known') ||
    s.includes('temporary failure in name resolution') ||
    s.includes('no address associated with hostname')
  ) {
    return 'dns';
  }
  if (
    s.includes('repository not found') ||
    s.includes('may not have access') ||
    s.includes('no longer exists') ||
    s.includes("don't have permission") ||
    s.includes('could not be found') ||
    s.includes('the requested url returned error: 404')
  ) {
    return 'not-found-or-no-access';
  }
  if (
    s.includes('authentication failed') ||
    s.includes('could not read username') ||
    s.includes('incorrect username or password') ||
    s.includes('the requested url returned error: 401') ||
    s.includes('the requested url returned error: 403')
  ) {
    return 'auth-failed';
  }
  return 'unknown';
}

/**
 * Probe each declared repo URL via host-side `git ls-remote`. Runs
 * sequentially (not parallel) so the output order matches the yml
 * order — easier to reason about when multiple repos fail, and the
 * total time is bounded by ~200 ms per repo against typical SaaS
 * hosts. Spawn-injected for tests.
 */
export async function checkRepoReachability(
  repos: readonly { url: string }[],
  options: { spawn?: ReachabilitySpawn } = {},
): Promise<RepoReachabilityStatus[]> {
  const spawnFn = options.spawn ?? realGitLsRemote;
  const results: RepoReachabilityStatus[] = [];
  for (const repo of repos) {
    // Only HTTPS URLs reach this code path (schema enforces it; pre-
    // flight already filtered). Skip belt-and-suspenders is in
    // credentials.ts — here we trust the input.
    let result: Awaited<ReturnType<ReachabilitySpawn>>;
    try {
      result = await spawnFn(repo.url);
    } catch (err) {
      results.push({
        url: repo.url,
        ok: false,
        kind: 'unknown',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (result.exitCode === 0) {
      results.push({ url: repo.url, ok: true, detail: '' });
      continue;
    }
    results.push({
      url: repo.url,
      ok: false,
      kind: classifyStderr(result.stderr),
      detail: result.stderr.trim(),
    });
  }
  return results;
}

/**
 * Render the consolidated pre-flight error for repos that couldn't
 * be reached. Groups failures by kind so each kind's actionable
 * advice appears once, with the failing URLs listed underneath.
 *
 * Layout:
 *
 *   Cannot reach <N> declared repo(s):
 *
 *   Repository not found (or your credentials don't grant access):
 *     • https://...
 *     • https://...
 *     - <actionable advice>
 *     - <actionable advice>
 *
 *   Authentication failed:
 *     • https://...
 *     - <actionable advice>
 *
 *   Then re-run `monoceros apply`.
 */
export function formatUnreachableReposError(
  failures: readonly RepoReachabilityStatus[],
): string {
  const byKind = new Map<ReachabilityFailureKind, RepoReachabilityStatus[]>();
  for (const f of failures) {
    const kind = f.kind ?? 'unknown';
    const list = byKind.get(kind) ?? [];
    list.push(f);
    byKind.set(kind, list);
  }
  const totalUrls = failures.length;
  const lines: string[] = [
    totalUrls === 1
      ? `Cannot reach declared repo: ${failures[0]!.url}`
      : `Cannot reach ${totalUrls} declared repos:`,
    '',
  ];

  const sectionOrder: ReachabilityFailureKind[] = [
    'not-found-or-no-access',
    'auth-failed',
    'dns',
    'unknown',
  ];
  for (const kind of sectionOrder) {
    const entries = byKind.get(kind);
    if (!entries || entries.length === 0) continue;
    lines.push(headerForKind(kind));
    for (const e of entries) {
      lines.push(`  • ${e.url}`);
    }
    for (const advice of adviceForKind(kind)) {
      lines.push(`    - ${advice}`);
    }
    lines.push('');
  }
  lines.push(`Then re-run ${cyan('monoceros apply')}.`);
  return lines.join('\n');
}

function headerForKind(kind: ReachabilityFailureKind): string {
  switch (kind) {
    case 'not-found-or-no-access':
      return "Repository not found (or your credentials don't grant access):";
    case 'auth-failed':
      return 'Authentication failed (credentials are present but rejected):';
    case 'dns':
      return "Host unreachable (DNS / VPN / offline — git couldn't resolve the hostname):";
    case 'unknown':
      return 'Unrecognised git error:';
  }
}

function adviceForKind(kind: ReachabilityFailureKind): string[] {
  switch (kind) {
    case 'not-found-or-no-access':
      return [
        'Re-check the URL for typos (case-sensitive on most hosts).',
        'Verify the repo still exists / is not archived in a way that hides it.',
        'Ensure your token covers this org / workspace and has read scope (GitHub: `repo`; GitLab: `read_repository`; Bitbucket: repo read).',
      ];
    case 'auth-failed':
      return [
        'Token may be expired or revoked — regenerate it from the provider UI.',
        'Re-run the provider CLI login (gh auth login / glab auth login) — Monoceros picks up the refreshed token on the next apply.',
      ];
    case 'dns':
      return [
        'Check your internet / VPN — corporate Git hosts often require VPN.',
        'Verify the hostname spelling in the yml.',
      ];
    case 'unknown':
      return [
        'Run `git ls-remote <url>` manually on the host to see the raw error.',
      ];
  }
}
