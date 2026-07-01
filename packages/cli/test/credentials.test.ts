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

const { uniqueHttpsHosts, parseCredentialFillOutput, formatCredentialLine } =
  _internals;

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

describe('parseCredentialFillOutput', () => {
  it('parses canonical git credential output', () => {
    const out = [
      'protocol=https',
      'host=github.com',
      'username=foo',
      'password=ghp_xxxxxxxxxxxxxxxx',
      '',
    ].join('\n');
    expect(parseCredentialFillOutput(out)).toEqual({
      username: 'foo',
      password: 'ghp_xxxxxxxxxxxxxxxx',
    });
  });

  it('returns missing fields as undefined', () => {
    const out = 'protocol=https\nhost=github.com\n';
    expect(parseCredentialFillOutput(out)).toEqual({});
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

  it('writes one line per HTTPS host using the host-side git', async () => {
    const calls: string[] = [];
    const result = await collectGitCredentials(
      cwd,
      [
        { host: 'github.com', provider: 'github' },
        { host: 'gitlab.com', provider: 'gitlab' },
      ],
      {
        spawn: async (input) => {
          calls.push(input);
          // Echo back a fake username/password tied to the host.
          const host = /host=([^\n]+)/.exec(input)?.[1] ?? 'unknown';
          return {
            stdout: `protocol=https\nhost=${host}\nusername=ci\npassword=tok-${host}\n`,
            exitCode: 0,
          };
        },
      },
    );

    expect(result.hostsWritten).toBe(2);
    expect(result.hostsSkipped).toBe(0);
    expect(result.perHost.every((p) => p.status === 'ok')).toBe(true);
    expect(calls).toEqual([
      'protocol=https\nhost=github.com\n\n',
      'protocol=https\nhost=gitlab.com\n\n',
    ]);

    const contents = await fs.readFile(
      path.join(cwd, '.monoceros', 'git-credentials'),
      'utf8',
    );
    expect(contents).toContain('https://ci:tok-github.com@github.com');
    expect(contents).toContain('https://ci:tok-gitlab.com@gitlab.com');
  });

  it('records no-credentials status when host-git returns no username/password', async () => {
    const result = await collectGitCredentials(
      cwd,
      [{ host: 'github.com', provider: 'github' }],
      {
        spawn: async () => ({
          stdout: 'protocol=https\nhost=github.com\n',
          exitCode: 0,
        }),
      },
    );
    expect(result.hostsWritten).toBe(0);
    expect(result.hostsSkipped).toBe(1);
    expect(result.perHost[0]!.status).toBe('no-credentials');
  });

  it('records non-zero-exit status when host-git exits non-zero', async () => {
    const result = await collectGitCredentials(
      cwd,
      [{ host: 'github.com', provider: 'github' }],
      {
        spawn: async () => ({ stdout: '', exitCode: 1 }),
      },
    );
    expect(result.hostsWritten).toBe(0);
    expect(result.hostsSkipped).toBe(1);
    expect(result.perHost[0]!.status).toBe('non-zero-exit');
  });

  it('writes the file with 0o600 permissions', async () => {
    await collectGitCredentials(
      cwd,
      [{ host: 'github.com', provider: 'github' }],
      {
        spawn: async () => ({
          stdout:
            'protocol=https\nhost=github.com\nusername=ci\npassword=tok\n',
          exitCode: 0,
        }),
      },
    );
    const stat = await fs.stat(path.join(cwd, '.monoceros', 'git-credentials'));
    // mode includes file type bits; mask to permission bits only.
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('formatMissingCredentialsError', () => {
  it('lists GitHub-specific gh setup when github.com is missing', async () => {
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'github.com',
        provider: 'github',
        status: 'no-credentials',
        detail: '',
      },
    ]);
    expect(msg).toContain('github.com');
    expect(msg).toContain('gh auth login');
    expect(msg).toContain('gh auth setup-git');
  });

  it('passes --hostname to gh auth login + setup-git for self-hosted GitHub Enterprise', async () => {
    // Self-hosted GitHub Enterprise Server needs --hostname on both
    // gh subcommands. For github.com SaaS the flag is omitted (gh
    // defaults to that host).
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'github.deine-firma.de',
        provider: 'github',
        status: 'no-credentials',
        detail: '',
      },
    ]);
    expect(msg).toContain('github.deine-firma.de');
    expect(msg).toContain('gh auth login --hostname github.deine-firma.de');
    expect(msg).toContain('gh auth setup-git --hostname github.deine-firma.de');
  });

  it('omits --hostname for github.com (SaaS default)', async () => {
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'github.com',
        provider: 'github',
        status: 'no-credentials',
        detail: '',
      },
    ]);
    expect(msg).not.toContain('--hostname');
  });

  it('lists glab CLI setup when gitlab.com is missing', async () => {
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'gitlab.com',
        provider: 'gitlab',
        status: 'no-credentials',
        detail: '',
      },
    ]);
    expect(msg).toContain('gitlab.com');
    expect(msg).toContain('glab auth login');
    // For gitlab.com itself, no --hostname flag should appear.
    expect(msg).not.toContain('--hostname gitlab.com');
  });

  it('passes --hostname to glab auth login for self-hosted GitLab', async () => {
    // Self-hosted host requires an explicit provider in the yml; the
    // pre-flight resolver passes that through and we render the right
    // --hostname flag.
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'git.firma.de',
        provider: 'gitlab',
        status: 'no-credentials',
        detail: '',
      },
    ]);
    expect(msg).toContain('git.firma.de');
    expect(msg).toContain('glab auth login --hostname git.firma.de');
  });

  it('renders the Bitbucket Cloud Atlassian-token flow for bitbucket.org', async () => {
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'bitbucket.org',
        provider: 'bitbucket',
        status: 'no-credentials',
        detail: '',
      },
    ]);
    expect(msg).toContain('bitbucket.org');
    expect(msg).toContain('Bitbucket Cloud');
    expect(msg).toContain('id.atlassian.com');
    expect(msg).toContain('git credential approve');
  });

  it('renders a Gitea token-via-UI flow (always self-hosted, no canonical SaaS branch)', async () => {
    // Gitea has no first-party credential-helper integration (`tea`
    // doesn't auto-wire to git credential), so the hint guides the
    // builder to the UI token flow + a direct `git credential
    // approve` call. Forgejo (Gitea fork) shares this flow.
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'gitea.deine-firma.de',
        provider: 'gitea',
        status: 'no-credentials',
        detail: '',
      },
    ]);
    expect(msg).toContain('gitea.deine-firma.de');
    expect(msg).toContain('Gitea');
    expect(msg).toContain('Generate New Token');
    expect(msg).toContain('read:repository');
    expect(msg).toContain('git credential approve');
    expect(msg).toContain('<your-gitea-username>');
  });

  it('renders the Bitbucket Data Center HTTP-access-token flow for self-hosted hosts', async () => {
    // Same provider value (`bitbucket`) — host-dependent branch
    // mirrors how github / gitlab handle SaaS vs self-hosted.
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'bitbucket.deine-firma.de',
        provider: 'bitbucket',
        status: 'no-credentials',
        detail: '',
      },
    ]);
    expect(msg).toContain('bitbucket.deine-firma.de');
    expect(msg).toContain('Bitbucket Data Center');
    expect(msg).toContain('HTTP access tokens');
    // Cloud-specific Atlassian SaaS link must NOT appear on Data Center.
    expect(msg).not.toContain('id.atlassian.com');
    // Username placeholder differs: local Bitbucket username, not email.
    expect(msg).toContain('<your-bitbucket-username>');
  });

  it('lists multiple failing hosts with per-host hints', async () => {
    const { formatMissingCredentialsError } =
      await import('../src/devcontainer/credentials.js');
    const msg = formatMissingCredentialsError([
      {
        host: 'github.com',
        provider: 'github',
        status: 'no-credentials',
        detail: '',
      },
      {
        host: 'gitlab.acme.example.com',
        provider: 'gitlab',
        status: 'no-credentials',
        detail: '',
      },
    ]);
    expect(msg).toContain('github.com');
    expect(msg).toContain('gitlab.acme.example.com');
    expect(msg).toContain('gh auth login');
    expect(msg).toContain('glab auth login --hostname gitlab.acme.example.com');
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
