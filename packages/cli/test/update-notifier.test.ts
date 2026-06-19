import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideUpdateAction,
  formatUpdateNotice,
  isNewerVersion,
  runUpdateCheck,
} from '../src/update/notifier.js';
import type { MachineState } from '../src/config/machine-state.js';

describe('isNewerVersion', () => {
  it('compares x.y.z numerically', () => {
    expect(isNewerVersion('1.31.0', '1.30.0')).toBe(true);
    expect(isNewerVersion('1.30.1', '1.30.0')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.30.0', '1.30.0')).toBe(false);
    expect(isNewerVersion('1.29.9', '1.30.0')).toBe(false);
  });

  it('is not-newer for non-semver (dev build never nags)', () => {
    expect(isNewerVersion('1.31.0', 'dev')).toBe(false);
    expect(isNewerVersion('garbage', '1.30.0')).toBe(false);
  });

  it('ignores prerelease / build suffixes', () => {
    expect(isNewerVersion('1.31.0-beta.1', '1.30.0')).toBe(true);
    expect(isNewerVersion('1.30.0-rc.1', '1.30.0')).toBe(false);
  });
});

describe('formatUpdateNotice', () => {
  it('names both versions and points at the install script, not npm', () => {
    const n = formatUpdateNotice('1.31.0', '1.30.0');
    expect(n).toContain('1.31.0');
    expect(n).toContain('1.30.0');
    expect(n).toContain('install.sh');
    expect(n).not.toContain('npm');
  });
});

describe('decideUpdateAction', () => {
  const now = new Date('2026-06-19T12:00:00Z');

  it('emits a notice when the cached latest is newer', () => {
    const { notice } = decideUpdateAction(
      { latestVersion: '1.31.0', lastVersionCheckAt: now.toISOString() },
      '1.30.0',
      now,
    );
    expect(notice).toContain('1.31.0');
  });

  it('no notice when cached latest is not newer or absent', () => {
    expect(
      decideUpdateAction({ latestVersion: '1.30.0' }, '1.30.0', now).notice,
    ).toBeNull();
    expect(decideUpdateAction({}, '1.30.0', now).notice).toBeNull();
  });

  it('refreshes when the cache is missing or older than the interval', () => {
    // never checked
    expect(decideUpdateAction({}, '1.30.0', now).refresh).toBe(true);
    // checked 2 days ago → stale
    const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    expect(
      decideUpdateAction({ lastVersionCheckAt: twoDaysAgo }, '1.30.0', now)
        .refresh,
    ).toBe(true);
    // checked an hour ago → fresh
    const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
    expect(
      decideUpdateAction({ lastVersionCheckAt: hourAgo }, '1.30.0', now)
        .refresh,
    ).toBe(false);
  });
});

describe('runUpdateCheck', () => {
  let home: string;
  const now = new Date('2026-06-19T12:00:00Z');

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'monoceros-upd-'));
    process.env.MONOCEROS_HOME = home;
  });
  afterEach(() => {
    delete process.env.MONOCEROS_HOME;
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
  });

  const readState = (): MachineState =>
    JSON.parse(readFileSync(path.join(home, '.machine-state.json'), 'utf8'));

  it('caches the fetched version + the check time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ version: '9.9.9' }),
      })),
    );
    await runUpdateCheck(now, home);
    const state = readState();
    expect(state.latestVersion).toBe('9.9.9');
    expect(state.lastVersionCheckAt).toBe(now.toISOString());
  });

  it('still stamps the check time when offline (backs off, keeps old version)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await runUpdateCheck(now, home);
    const state = readState();
    expect(state.lastVersionCheckAt).toBe(now.toISOString());
    expect(state.latestVersion).toBeUndefined();
  });
});
