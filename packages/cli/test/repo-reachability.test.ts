import { describe, expect, it } from 'vitest';
import {
  type ReachabilitySpawn,
  checkRepoReachability,
  formatUnreachableReposError,
} from '../src/devcontainer/repo-reachability.js';

/**
 * Stderr samples taken from real `git ls-remote` failures against
 * each provider. Keeping them as constants documents what we're
 * trying to recognise; if any of these strings change in future git
 * / provider releases, the test fails loud rather than the
 * production classifier silently dropping into `unknown`.
 */
const STDERR_SAMPLES = {
  githubNotFound:
    "remote: Repository not found.\nfatal: repository 'https://github.com/foo/missing.git/' not found",
  gitlabNoAccess:
    "remote: The project you were looking for could not be found or you don't have permission to view it.",
  bitbucketCloudNoAccess:
    "remote: You may not have access to this repository or it no longer exists in this workspace. If you think this repository exists and you have access, make sure you are authenticated.\nfatal: Authentication failed for 'https://bitbucket.org/conciso/monoceros-app.git/'",
  authFailed:
    "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/foo/bar.git/'",
  dns: "fatal: unable to access 'https://git.firma.de/foo/bar.git/': Could not resolve host: git.firma.de",
};

const makeSpawn = (
  responses: Record<string, { stderr: string; exitCode: number }>,
): ReachabilitySpawn => {
  return async (url) => {
    const resp = responses[url];
    if (!resp) return { stdout: 'OK', stderr: '', exitCode: 0 };
    return { stdout: '', stderr: resp.stderr, exitCode: resp.exitCode };
  };
};

describe('checkRepoReachability', () => {
  it('marks ok for repos whose ls-remote exits 0', async () => {
    const result = await checkRepoReachability(
      [
        { url: 'https://github.com/foo/bar.git' },
        { url: 'https://gitlab.com/baz/qux.git' },
      ],
      { spawn: makeSpawn({}) },
    );
    expect(result.every((r) => r.ok)).toBe(true);
  });

  it('classifies GitHub "Repository not found" as not-found-or-no-access', async () => {
    const result = await checkRepoReachability(
      [{ url: 'https://github.com/foo/missing.git' }],
      {
        spawn: makeSpawn({
          'https://github.com/foo/missing.git': {
            stderr: STDERR_SAMPLES.githubNotFound,
            exitCode: 128,
          },
        }),
      },
    );
    expect(result[0]!.ok).toBe(false);
    expect(result[0]!.kind).toBe('not-found-or-no-access');
  });

  it('classifies GitLab "could not be found or you don\'t have permission" as not-found-or-no-access', async () => {
    const result = await checkRepoReachability(
      [{ url: 'https://gitlab.com/foo/missing.git' }],
      {
        spawn: makeSpawn({
          'https://gitlab.com/foo/missing.git': {
            stderr: STDERR_SAMPLES.gitlabNoAccess,
            exitCode: 128,
          },
        }),
      },
    );
    expect(result[0]!.kind).toBe('not-found-or-no-access');
  });

  it('classifies Bitbucket Cloud "may not have access" as not-found-or-no-access', async () => {
    // The verbatim stderr from the issue thread that prompted this
    // pre-flight stage being built (M5 cont., 2026-05-23).
    const result = await checkRepoReachability(
      [{ url: 'https://bitbucket.org/conciso/monoceros-app.git' }],
      {
        spawn: makeSpawn({
          'https://bitbucket.org/conciso/monoceros-app.git': {
            stderr: STDERR_SAMPLES.bitbucketCloudNoAccess,
            exitCode: 128,
          },
        }),
      },
    );
    expect(result[0]!.kind).toBe('not-found-or-no-access');
  });

  it('classifies "Authentication failed" alone as auth-failed', async () => {
    const result = await checkRepoReachability(
      [{ url: 'https://github.com/foo/bar.git' }],
      {
        spawn: makeSpawn({
          'https://github.com/foo/bar.git': {
            stderr: STDERR_SAMPLES.authFailed,
            exitCode: 128,
          },
        }),
      },
    );
    expect(result[0]!.kind).toBe('auth-failed');
  });

  it('classifies "Could not resolve host" as dns', async () => {
    const result = await checkRepoReachability(
      [{ url: 'https://git.firma.de/foo/bar.git' }],
      {
        spawn: makeSpawn({
          'https://git.firma.de/foo/bar.git': {
            stderr: STDERR_SAMPLES.dns,
            exitCode: 128,
          },
        }),
      },
    );
    expect(result[0]!.kind).toBe('dns');
  });

  it('uses "unknown" for unrecognised stderr', async () => {
    const result = await checkRepoReachability(
      [{ url: 'https://x.example.com/foo/bar.git' }],
      {
        spawn: makeSpawn({
          'https://x.example.com/foo/bar.git': {
            stderr: 'fatal: some weird new error from a future git release',
            exitCode: 128,
          },
        }),
      },
    );
    expect(result[0]!.kind).toBe('unknown');
  });

  it('captures the raw stderr in detail for diagnostics', async () => {
    const result = await checkRepoReachability(
      [{ url: 'https://github.com/foo/missing.git' }],
      {
        spawn: makeSpawn({
          'https://github.com/foo/missing.git': {
            stderr: STDERR_SAMPLES.githubNotFound,
            exitCode: 128,
          },
        }),
      },
    );
    expect(result[0]!.detail).toContain('Repository not found');
  });

  it('returns kind=unknown if the spawn itself throws', async () => {
    const result = await checkRepoReachability(
      [{ url: 'https://github.com/foo/bar.git' }],
      {
        spawn: async () => {
          throw new Error('ENOENT: git not on PATH');
        },
      },
    );
    expect(result[0]!.ok).toBe(false);
    expect(result[0]!.kind).toBe('unknown');
    expect(result[0]!.detail).toContain('git not on PATH');
  });

  it('processes repos in input order (matters for error rendering)', async () => {
    const result = await checkRepoReachability(
      [
        { url: 'https://github.com/a.git' },
        { url: 'https://github.com/b.git' },
        { url: 'https://github.com/c.git' },
      ],
      { spawn: makeSpawn({}) },
    );
    expect(result.map((r) => r.url)).toEqual([
      'https://github.com/a.git',
      'https://github.com/b.git',
      'https://github.com/c.git',
    ]);
  });
});

describe('formatUnreachableReposError', () => {
  it('renders a single repo failure inline', () => {
    const msg = formatUnreachableReposError([
      {
        url: 'https://bitbucket.org/conciso/monoceros-app.git',
        ok: false,
        kind: 'not-found-or-no-access',
        detail: STDERR_SAMPLES.bitbucketCloudNoAccess,
      },
    ]);
    expect(msg).toContain('Cannot reach declared repo:');
    expect(msg).toContain('https://bitbucket.org/conciso/monoceros-app.git');
    expect(msg).toContain('Repository not found');
    // Provider-aware token-scope hint surfaces, not provider-specific
    // commands — the kind drives the prose, not the host.
    expect(msg).toContain('read scope');
  });

  it('groups multiple failures by kind, each kind appears once', () => {
    const msg = formatUnreachableReposError([
      {
        url: 'https://github.com/foo/missing.git',
        ok: false,
        kind: 'not-found-or-no-access',
        detail: '',
      },
      {
        url: 'https://gitlab.com/foo/missing.git',
        ok: false,
        kind: 'not-found-or-no-access',
        detail: '',
      },
      {
        url: 'https://git.firma.de/foo/bar.git',
        ok: false,
        kind: 'dns',
        detail: '',
      },
    ]);
    // Header counts all three URLs.
    expect(msg).toContain('Cannot reach 3 declared repos:');
    // Two URLs under the not-found-or-no-access header.
    expect(msg).toContain('https://github.com/foo/missing.git');
    expect(msg).toContain('https://gitlab.com/foo/missing.git');
    // One under DNS.
    expect(msg).toContain('https://git.firma.de/foo/bar.git');
    // Each kind header appears exactly once.
    const occurrences = (s: string, sub: string) => s.split(sub).length - 1;
    expect(occurrences(msg, 'Repository not found')).toBe(1);
    expect(occurrences(msg, 'Host unreachable')).toBe(1);
  });

  it('includes per-kind advice for auth-failed (re-login)', () => {
    const msg = formatUnreachableReposError([
      {
        url: 'https://github.com/foo/bar.git',
        ok: false,
        kind: 'auth-failed',
        detail: '',
      },
    ]);
    expect(msg).toContain('Authentication failed');
    expect(msg).toContain('Token may be expired');
    expect(msg).toContain('gh auth login');
    expect(msg).toContain('glab auth login');
  });

  it('ends with the re-run hint', () => {
    const msg = formatUnreachableReposError([
      {
        url: 'https://github.com/foo/bar.git',
        ok: false,
        kind: 'unknown',
        detail: '',
      },
    ]);
    expect(msg).toMatch(/re-run.*monoceros apply/);
  });

  it('surfaces the raw git stderr verbatim under the failing repo', () => {
    const msg = formatUnreachableReposError([
      {
        url: 'https://github.com/conciso/logoscraper.git',
        ok: false,
        kind: 'auth-failed',
        detail:
          "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      },
    ]);
    expect(msg).toContain(
      "git: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
  });

  it('renders each line of a multi-line stderr with the git: prefix', () => {
    const msg = formatUnreachableReposError([
      {
        url: 'https://github.com/foo/bar.git',
        ok: false,
        kind: 'unknown',
        detail: 'remote: line one\nfatal: line two',
      },
    ]);
    expect(msg).toContain('git: remote: line one');
    expect(msg).toContain('git: fatal: line two');
  });
});
