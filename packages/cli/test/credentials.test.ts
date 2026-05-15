import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _internals,
  collectGitCredentials,
} from '../src/devcontainer/credentials.js';

const { uniqueHttpsHosts, parseCredentialFillOutput, formatCredentialLine } =
  _internals;

describe('uniqueHttpsHosts', () => {
  it('extracts the hostname from https URLs', () => {
    expect(
      uniqueHttpsHosts([
        { url: 'https://github.com/foo/bar.git', name: 'bar' },
        { url: 'https://gitlab.com/baz/qux.git', name: 'qux' },
      ]),
    ).toEqual(['github.com', 'gitlab.com']);
  });

  it('dedupes repeated hosts', () => {
    expect(
      uniqueHttpsHosts([
        { url: 'https://github.com/foo/bar.git', name: 'bar' },
        { url: 'https://github.com/baz/qux.git', name: 'qux' },
      ]),
    ).toEqual(['github.com']);
  });

  it('skips non-https schemes', () => {
    expect(
      uniqueHttpsHosts([
        { url: 'git@github.com:foo/bar.git', name: 'bar' },
        { url: 'ssh://git@github.com/foo/bar.git', name: 'bar2' },
        { url: 'https://gitlab.com/baz/qux.git', name: 'qux' },
      ]),
    ).toEqual(['gitlab.com']);
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
        { url: 'https://github.com/foo/bar.git', name: 'bar' },
        { url: 'https://gitlab.com/baz/qux.git', name: 'qux' },
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

  it('skips SSH and git@ URLs', async () => {
    let calls = 0;
    const result = await collectGitCredentials(
      cwd,
      [
        { url: 'git@github.com:foo/bar.git', name: 'bar' },
        { url: 'ssh://git@github.com/foo/baz.git', name: 'baz' },
      ],
      {
        spawn: async () => {
          calls += 1;
          return { stdout: '', exitCode: 0 };
        },
      },
    );
    expect(calls).toBe(0);
    expect(result.hostsWritten).toBe(0);
    expect(result.hostsSkipped).toBe(0);
    // File is still written (empty) — bind-mount target must exist.
    const contents = await fs.readFile(
      path.join(cwd, '.monoceros', 'git-credentials'),
      'utf8',
    );
    expect(contents).toBe('');
  });

  it('records hostsSkipped when host-git returns no credentials', async () => {
    const result = await collectGitCredentials(
      cwd,
      [{ url: 'https://github.com/foo/bar.git', name: 'bar' }],
      {
        spawn: async () => ({
          stdout: 'protocol=https\nhost=github.com\n',
          exitCode: 0,
        }),
      },
    );
    expect(result.hostsWritten).toBe(0);
    expect(result.hostsSkipped).toBe(1);
  });

  it('records hostsSkipped when host-git exits non-zero', async () => {
    const result = await collectGitCredentials(
      cwd,
      [{ url: 'https://github.com/foo/bar.git', name: 'bar' }],
      {
        spawn: async () => ({
          stdout: '',
          exitCode: 1,
        }),
      },
    );
    expect(result.hostsWritten).toBe(0);
    expect(result.hostsSkipped).toBe(1);
  });

  it('writes the file with 0o600 permissions', async () => {
    await collectGitCredentials(
      cwd,
      [{ url: 'https://github.com/foo/bar.git', name: 'bar' }],
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
