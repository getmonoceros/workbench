import { describe, expect, it } from 'vitest';
import {
  nextRelayUrl,
  parseCallbackTarget,
} from '../src/devcontainer/browser-bridge.js';

describe('nextRelayUrl', () => {
  it('relays a new URL, trims, and skips blanks', () => {
    expect(nextRelayUrl('http://a\n', null)).toBe('http://a');
    expect(nextRelayUrl('  \n', null)).toBeNull();
    expect(nextRelayUrl('', 'http://a')).toBeNull();
  });

  it('skips a repeat of the last URL but relays a changed one', () => {
    // Same as last → poller must not re-open it every tick.
    expect(nextRelayUrl('http://a\n', 'http://a')).toBeNull();
    // A new app-open after an earlier OAuth open → relayed.
    expect(nextRelayUrl('http://verein.localhost', 'http://oauth')).toBe(
      'http://verein.localhost',
    );
  });
});

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
