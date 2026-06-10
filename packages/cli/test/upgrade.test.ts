import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runUpgrade,
  setRuntimeVersion,
  type UpgradeOptions,
} from '../src/upgrade/index.js';
import type { RunApplyOptions, RunApplyResult } from '../src/apply/index.js';

describe('setRuntimeVersion', () => {
  it('replaces an existing runtimeVersion line, preserving the rest', () => {
    const yml = 'schemaVersion: 1\nruntimeVersion: 1.1.0\nname: demo\n';
    expect(setRuntimeVersion(yml, '1.2.0')).toBe(
      'schemaVersion: 1\nruntimeVersion: 1.2.0\nname: demo\n',
    );
  });

  it('inserts after schemaVersion when absent', () => {
    const yml = 'schemaVersion: 1\nname: demo\n';
    expect(setRuntimeVersion(yml, '1.1.0')).toBe(
      'schemaVersion: 1\nruntimeVersion: 1.1.0\nname: demo\n',
    );
  });

  it('prepends when neither field is present', () => {
    expect(setRuntimeVersion('name: demo\n', '1.1.0')).toBe(
      'runtimeVersion: 1.1.0\nname: demo\n',
    );
  });
});

describe('runUpgrade', () => {
  let home: string;
  const messages: string[] = [];
  const logger = {
    info: (m: string) => messages.push(`info:${m}`),
    success: (m: string) => messages.push(`success:${m}`),
    warn: (m: string) => messages.push(`warn:${m}`),
  };
  const appliedWith: RunApplyOptions[] = [];
  const applyRunner = async (o: RunApplyOptions): Promise<RunApplyResult> => {
    appliedWith.push(o);
    return { containerExitCode: 0 } as unknown as RunApplyResult;
  };

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-upgrade-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    messages.length = 0;
    appliedWith.length = 0;
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function base(over: Partial<UpgradeOptions> = {}): UpgradeOptions {
    return {
      cliVersion: '9.9.9',
      monocerosHome: home,
      logger,
      applyRunner,
      fetchVersions: async () => ['1.0.0', '1.1.0', '1.2.0'],
      ...over,
    };
  }
  const ymlPath = (name: string) =>
    path.join(home, 'container-configs', `${name}.yml`);

  it('pins an explicit version into the yml and re-applies', async () => {
    await writeFile(ymlPath('demo'), 'schemaVersion: 1\nname: demo\n');
    const code = await runUpgrade(base({ name: 'demo', version: '1.2.0' }));
    expect(code).toBe(0);
    expect(await readFile(ymlPath('demo'), 'utf8')).toContain(
      'runtimeVersion: 1.2.0',
    );
    expect(appliedWith).toEqual([
      { name: 'demo', cliVersion: '9.9.9', monocerosHome: home, rebuild: true },
    ]);
  });

  it('refreshes ALL containers (rebuild) and stamps the run when no name is given', async () => {
    await writeFile(ymlPath('alpha'), 'schemaVersion: 1\nname: alpha\n');
    await writeFile(ymlPath('beta'), 'schemaVersion: 1\nname: beta\n');
    const code = await runUpgrade(
      base({ now: new Date('2026-06-10T00:00:00.000Z') }),
    );
    expect(code).toBe(0);
    expect(appliedWith.map((o) => o.name).sort()).toEqual(['alpha', 'beta']);
    expect(appliedWith.every((o) => o.rebuild === true)).toBe(true);
    // Last-upgrade timestamp recorded in machine state.
    const state = JSON.parse(
      await readFile(path.join(home, '.machine-state.json'), 'utf8'),
    );
    expect(state.lastUpgradeAt).toBe('2026-06-10T00:00:00.000Z');
  });

  it('refuses a version without a name (cannot pin a base globally)', async () => {
    await expect(runUpgrade(base({ version: '1.2.0' }))).rejects.toThrow(
      /only be pinned for one container/,
    );
  });

  it('pins to the latest published version when none is given', async () => {
    await writeFile(
      ymlPath('demo'),
      'schemaVersion: 1\nruntimeVersion: 1.0.0\nname: demo\n',
    );
    const code = await runUpgrade(base({ name: 'demo' }));
    expect(code).toBe(0);
    expect(await readFile(ymlPath('demo'), 'utf8')).toContain(
      'runtimeVersion: 1.2.0',
    );
  });

  it('--list prints available versions and does not apply', async () => {
    const code = await runUpgrade(base({ list: true }));
    expect(code).toBe(0);
    expect(appliedWith).toHaveLength(0);
    expect(messages.join('\n')).toMatch(/1\.0\.0[\s\S]*1\.1\.0[\s\S]*1\.2\.0/);
  });

  it('rejects an invalid version string', async () => {
    await writeFile(ymlPath('demo'), 'schemaVersion: 1\nname: demo\n');
    await expect(
      runUpgrade(base({ name: 'demo', version: 'latest' })),
    ).rejects.toThrow(/Invalid version/);
  });

  it('errors when the config does not exist', async () => {
    await expect(
      runUpgrade(base({ name: 'nope', version: '1.1.0' })),
    ).rejects.toThrow(/No such config/);
  });
});
