import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runLogin } from '../src/login/index.js';
import { _resetPathCachesForTests } from '../src/config/paths.js';
import {
  featureLeaf,
  loginCapableServices,
  parseCallbackTarget,
} from '../src/login/services.js';

describe('featureLeaf', () => {
  it('strips the host path and the tag', () => {
    expect(
      featureLeaf('ghcr.io/getmonoceros/monoceros-features/claude-code:1'),
    ).toBe('claude-code');
    expect(featureLeaf('ghcr.io/devcontainers/features/github-cli:1')).toBe(
      'github-cli',
    );
  });
});

describe('loginCapableServices', () => {
  it('maps the claude-code feature to the `claude` service', () => {
    expect(
      loginCapableServices([
        'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
      ]),
    ).toEqual(['claude']);
  });

  it('ignores features without a Monoceros login', () => {
    expect(
      loginCapableServices([
        'ghcr.io/devcontainers/features/node:1',
        'ghcr.io/getmonoceros/monoceros-features/github-cli:1',
      ]),
    ).toEqual([]);
  });

  it('dedupes', () => {
    expect(
      loginCapableServices([
        'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        'ghcr.io/getmonoceros/monoceros-features/claude-code:2',
      ]),
    ).toEqual(['claude']);
  });
});

describe('parseCallbackTarget', () => {
  it('extracts port + path from a localhost redirect_uri (auto-callback flow)', () => {
    const url =
      'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=' +
      encodeURIComponent('http://localhost:39361/callback') +
      '&code_challenge_method=S256';
    expect(parseCallbackTarget(url)).toEqual({
      port: 39361,
      pathname: '/callback',
    });
  });

  it('returns null for the manual paste-code flow (non-localhost redirect)', () => {
    const url =
      'https://claude.com/cai/oauth/authorize?redirect_uri=' +
      encodeURIComponent('https://platform.claude.com/oauth/code/callback');
    expect(parseCallbackTarget(url)).toBeNull();
  });

  it('returns null when there is no redirect_uri or the url is junk', () => {
    expect(
      parseCallbackTarget('https://claude.com/cai/oauth/authorize?code=true'),
    ).toBeNull();
    expect(parseCallbackTarget('not a url')).toBeNull();
  });
});

describe('runLogin dispatch', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-login-'));
    prevHome = process.env.MONOCEROS_HOME;
    process.env.MONOCEROS_HOME = home;
    _resetPathCachesForTests();
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    await mkdir(path.join(home, 'container', 'box', '.devcontainer'), {
      recursive: true,
    });
    await writeFile(
      path.join(home, 'container-configs', 'box.yml'),
      'schemaVersion: 1\nname: box\nfeatures:\n  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1\n',
    );
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.MONOCEROS_HOME;
    else process.env.MONOCEROS_HOME = prevHome;
    _resetPathCachesForTests();
    await rm(home, { recursive: true, force: true });
  });

  it('lists tools without logging in when no tool is named', async () => {
    // No feature arg → just report what's available (return 0, no spawn).
    expect(await runLogin({ name: 'box' })).toBe(0);
  });

  it('errors when the named tool is not login-capable', async () => {
    expect(await runLogin({ name: 'box', feature: 'github' })).toBe(1);
  });
});
