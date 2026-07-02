import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _internals,
  collectGitCredentials,
  resolveProvider,
} from '../src/devcontainer/credentials.js';

const { uniqueHttpsHosts, formatCredentialLine } = _internals;

describe('resolveProvider', () => {
  it('maps the canonical hosts to their fixed provider', () => {
    expect(resolveProvider('github.com')).toBe('github');
    expect(resolveProvider('gitlab.com')).toBe('gitlab');
    expect(resolveProvider('bitbucket.org')).toBe('bitbucket');
  });

  it('canonical lookup is case-insensitive', () => {
    expect(resolveProvider('GITHUB.com')).toBe('github');
  });

  it('canonical mapping wins over an explicit hint (it is the source of truth)', () => {
    // Belt-and-suspenders: if someone writes provider: gitlab next to
    // github.com (typo / yml refactor mishap), we still treat it as
    // GitHub. The canonical host is authoritative.
    expect(resolveProvider('github.com', 'gitlab')).toBe('github');
  });

  it('non-canonical host + explicit hint → that provider', () => {
    expect(resolveProvider('git.firma.de', 'gitlab')).toBe('gitlab');
    expect(resolveProvider('code.acme.com', 'bitbucket')).toBe('bitbucket');
  });

  it('non-canonical host without hint → "unknown"', () => {
    expect(resolveProvider('git.firma.de')).toBe('unknown');
    // Historical heuristic — startsWith('gitlab.') used to match.
    // We no longer guess; only the explicit hint or the exact
    // gitlab.com canonical mapping is allowed.
    expect(resolveProvider('gitlab.acme.example.com')).toBe('unknown');
  });
});

describe('uniqueHttpsHosts', () => {
  it('returns host+provider pairs derived from URLs', () => {
    expect(
      uniqueHttpsHosts([
        { url: 'https://github.com/foo/bar.git', path: 'bar' },
        { url: 'https://gitlab.com/baz/qux.git', path: 'qux' },
      ]),
    ).toEqual([
      { host: 'github.com', provider: 'github' },
      { host: 'gitlab.com', provider: 'gitlab' },
    ]);
  });

  it('dedupes repeated hosts', () => {
    expect(
      uniqueHttpsHosts([
        { url: 'https://github.com/foo/bar.git', path: 'bar' },
        { url: 'https://github.com/baz/qux.git', path: 'qux' },
      ]),
    ).toEqual([{ host: 'github.com', provider: 'github' }]);
  });

  it('uses the explicit provider for non-canonical hosts', () => {
    expect(
      uniqueHttpsHosts([
        {
          url: 'https://git.firma.de/team/app.git',
          path: 'app',
          provider: 'gitlab',
        },
      ]),
    ).toEqual([{ host: 'git.firma.de', provider: 'gitlab' }]);
  });

  it('flags non-canonical hosts without provider as "unknown"', () => {
    expect(
      uniqueHttpsHosts([
        { url: 'https://git.firma.de/team/app.git', path: 'app' },
      ]),
    ).toEqual([{ host: 'git.firma.de', provider: 'unknown' }]);
  });

  it('skips non-https schemes (defense-in-depth, schema also rejects these)', () => {
    // The schema (config/schema.ts REPO_URL_RE) rejects SSH-style URLs
    // at parse time per ADR 0006. This runtime filter is belt-and-
    // suspenders — it ensures that even if a caller hands a non-https
    // URL to uniqueHttpsHosts directly (test fixtures, future callers,
    // etc.), it gets ignored cleanly rather than producing a malformed
    // credentials lookup.
    expect(
      uniqueHttpsHosts([
        { url: 'git@github.com:foo/bar.git', path: 'bar' },
        { url: 'ssh://git@github.com/foo/bar.git', path: 'bar2' },
        { url: 'https://gitlab.com/baz/qux.git', path: 'qux' },
      ]),
    ).toEqual([{ host: 'gitlab.com', provider: 'gitlab' }]);
  });
});

describe('formatCredentialLine', () => {
  it('emits an URL-shaped line with percent-encoded fields', () => {
    expect(formatCredentialLine('github.com', 'foo', 'ghp_xyz')).toBe(
      'https://foo:ghp_xyz@github.com',
    );
  });

  it('percent-encodes special characters in token', () => {
    // A `@` or `:` in the token would break URL parsing; encoding
    // them keeps the `store` helper from misinterpreting the line.
    const line = formatCredentialLine('gitlab.com', 'foo', 'pass:with@chars');
    expect(line).toBe('https://foo:pass%3Awith%40chars@gitlab.com');
  });
});

describe('collectGitCredentials', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'monoceros-credentials-'));
    await fs.mkdir(path.join(cwd, '.monoceros'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('writes one oauth2:<token> line per host from the configured tokens', async () => {
    const result = await collectGitCredentials(
      cwd,
      [
        { host: 'github.com', provider: 'github' },
        { host: 'gitlab.com', provider: 'gitlab' },
      ],
      {
        patByHost: new Map([
          ['github.com', 'ghp_x'],
          ['gitlab.com', 'glpat_y'],
        ]),
      },
    );

    expect(result.hostsWritten).toBe(2);
    expect(result.hostsSkipped).toBe(0);
    expect(result.perHost.every((p) => p.status === 'ok')).toBe(true);

    const contents = await fs.readFile(
      path.join(cwd, '.monoceros', 'git-credentials'),
      'utf8',
    );
    expect(contents).toContain('https://oauth2:ghp_x@github.com');
    expect(contents).toContain('https://oauth2:glpat_y@gitlab.com');
  });

  it('writes the Bitbucket static username for a bitbucket token', async () => {
    await collectGitCredentials(
      cwd,
      [{ host: 'bitbucket.org', provider: 'bitbucket' }],
      { patByHost: new Map([['bitbucket.org', 'atatt_x']]) },
    );
    const contents = await fs.readFile(
      path.join(cwd, '.monoceros', 'git-credentials'),
      'utf8',
    );
    expect(contents).toContain(
      'https://x-bitbucket-api-token-auth:atatt_x@bitbucket.org',
    );
  });

  it('reports no-token for a host without a configured token', async () => {
    const result = await collectGitCredentials(
      cwd,
      [
        { host: 'github.com', provider: 'github' },
        { host: 'gitlab.com', provider: 'gitlab' },
      ],
      { patByHost: new Map([['github.com', 'ghp_x']]) },
    );

    expect(result.hostsWritten).toBe(1);
    expect(result.hostsSkipped).toBe(1);
    expect(result.perHost.find((p) => p.host === 'github.com')!.status).toBe(
      'ok',
    );
    expect(result.perHost.find((p) => p.host === 'gitlab.com')!.status).toBe(
      'no-token',
    );
  });

  it('writes the file with 0o600 permissions', async () => {
    await collectGitCredentials(
      cwd,
      [{ host: 'github.com', provider: 'github' }],
      {
        patByHost: new Map([['github.com', 'ghp_x']]),
      },
    );
    const stat = await fs.stat(path.join(cwd, '.monoceros', 'git-credentials'));
    // mode includes file type bits; mask to permission bits only.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('formatMissingCredentialsError', () => {
  it('tells the builder to set a token, pointing at the docs (GitHub)', async () => {
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'github.com',
        provider: 'github',
        status: 'no-token',
        detail: '',
      },
    ]);
    expect(msg).toContain('GitHub');
    expect(msg).toContain('github.com');
    expect(msg).toContain('personal access token');
    expect(msg).toContain('getmonoceros.build/docs/concepts/git-and-repos');
    // No host-tooling instructions anymore.
    expect(msg).not.toContain('gh auth login');
  });

  it('tells the builder to set a token for a Bitbucket host with none', async () => {
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'bitbucket.org',
        provider: 'bitbucket',
        status: 'no-token',
        detail: '',
      },
    ]);
    expect(msg).toContain('Bitbucket');
    expect(msg).toContain('bitbucket.org');
    expect(msg).toContain('GIT_TOKEN__BITBUCKET_<WORKSPACE>');
  });

  it('lists multiple failing hosts, one line each', async () => {
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'github.com',
        provider: 'github',
        status: 'no-token',
        detail: '',
      },
      {
        host: 'gitlab.acme.example.com',
        provider: 'gitlab',
        status: 'no-token',
        detail: '',
      },
    ]);
    expect(msg).toContain('github.com');
    expect(msg).toContain('gitlab.acme.example.com');
  });
});

describe('formatUnknownProviderError', () => {
  it('lists the host and tells the builder to set provider:', async () => {
    const { formatUnknownProviderError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatUnknownProviderError(['git.firma.de']);
    expect(msg).toContain('git.firma.de');
    expect(msg).toContain('provider:');
    expect(msg).toContain('gitlab');
    expect(msg).toContain('add-repo');
  });

  it('aggregates multiple unknown hosts', async () => {
    const { formatUnknownProviderError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatUnknownProviderError(['git.b.io', 'git.a.io']);
    // sorted for stable output
    expect(msg.indexOf('git.a.io')).toBeLessThan(msg.indexOf('git.b.io'));
  });
});
