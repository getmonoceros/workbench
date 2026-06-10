import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_UPGRADE_STALE_DAYS,
  daysBetween,
  machineStatePath,
  markUpgraded,
  readMachineState,
  recordBuiltImage,
  upgradeNudge,
  writeMachineState,
} from '../src/config/machine-state.js';

describe('machine-state persistence', () => {
  let home: string;
  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), 'mono-machine-state-'));
  });
  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it('reads empty state when the file is missing or malformed', async () => {
    expect(await readMachineState(home)).toEqual({});
    await fsp.writeFile(machineStatePath(home), 'not json {');
    expect(await readMachineState(home)).toEqual({});
  });

  it('round-trips state', async () => {
    await writeMachineState(
      { lastUpgradeAt: '2026-06-01T00:00:00.000Z' },
      home,
    );
    expect((await readMachineState(home)).lastUpgradeAt).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('records built images and dedups by imageId (newest wins)', async () => {
    await recordBuiltImage(
      { imageId: 'sha256:aaa', container: 'foo', builtAt: 't1' },
      home,
    );
    await recordBuiltImage(
      { imageId: 'sha256:bbb', container: 'bar', builtAt: 't2' },
      home,
    );
    await recordBuiltImage(
      { imageId: 'sha256:aaa', container: 'foo', builtAt: 't3' },
      home,
    );
    const { builtImages } = await readMachineState(home);
    expect(builtImages).toHaveLength(2);
    expect(builtImages!.find((r) => r.imageId === 'sha256:aaa')!.builtAt).toBe(
      't3',
    );
  });

  it('markUpgraded sets the timestamp without dropping the registry', async () => {
    await recordBuiltImage(
      { imageId: 'sha256:aaa', container: 'foo', builtAt: 't1' },
      home,
    );
    await markUpgraded('2026-06-10T12:00:00.000Z', home);
    const state = await readMachineState(home);
    expect(state.lastUpgradeAt).toBe('2026-06-10T12:00:00.000Z');
    expect(state.builtImages).toHaveLength(1);
  });
});

describe('daysBetween', () => {
  it('floors whole days and never goes negative', () => {
    const now = new Date('2026-06-10T00:00:00.000Z');
    expect(daysBetween('2026-06-10T00:00:00.000Z', now)).toBe(0);
    expect(daysBetween('2026-06-09T01:00:00.000Z', now)).toBe(0); // 23h
    expect(daysBetween('2026-06-01T00:00:00.000Z', now)).toBe(9);
    expect(daysBetween('2026-06-20T00:00:00.000Z', now)).toBe(0); // future
    expect(daysBetween('garbage', now)).toBe(0);
  });
});

describe('upgradeNudge', () => {
  const now = new Date('2026-06-10T00:00:00.000Z');

  it('is silent when no upgrade has ever run (fresh container is current)', () => {
    expect(upgradeNudge({}, now)).toBeNull();
  });

  it('is silent within the threshold', () => {
    expect(
      upgradeNudge({ lastUpgradeAt: '2026-06-05T00:00:00.000Z' }, now),
    ).toBeNull();
  });

  it('nudges past the threshold and names the day count + command', () => {
    const msg = upgradeNudge(
      { lastUpgradeAt: '2026-04-01T00:00:00.000Z' },
      now,
    );
    expect(msg).toContain('monoceros upgrade');
    expect(msg).toContain('70 days');
  });

  it('respects a custom threshold', () => {
    const state = { lastUpgradeAt: '2026-06-03T00:00:00.000Z' }; // 7 days
    expect(upgradeNudge(state, now, 5)).toContain('7 days');
    expect(upgradeNudge(state, now, 10)).toBeNull();
  });

  it('default threshold is 30 days', () => {
    expect(DEFAULT_UPGRADE_STALE_DAYS).toBe(30);
  });
});
