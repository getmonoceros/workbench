import { describe, expect, it } from 'vitest';
import { parseCallbackTarget } from '../src/devcontainer/browser-bridge.js';

describe('parseCallbackTarget', () => {
  it('extracts port + path from a localhost redirect_uri (loopback callback)', () => {
    const url =
      'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=' +
      encodeURIComponent('http://localhost:39361/callback') +
      '&code_challenge_method=S256';
    expect(parseCallbackTarget(url)).toEqual({
      port: 39361,
      pathname: '/callback',
    });
  });

  it('returns null for a non-localhost redirect (remote paste-code flow)', () => {
    const url =
      'https://claude.com/cai/oauth/authorize?redirect_uri=' +
      encodeURIComponent('https://platform.claude.com/oauth/code/callback');
    expect(parseCallbackTarget(url)).toBeNull();
  });

  it('returns null with no redirect_uri or junk input', () => {
    expect(
      parseCallbackTarget('https://claude.com/cai/oauth/authorize?code=true'),
    ).toBeNull();
    expect(parseCallbackTarget('not a url')).toBeNull();
  });
});
