import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runApply } from '../src/apply/index.js';
import { readStateFile } from '../src/config/state.js';

const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
};

const stubDevcontainerSpawn = async () => 0;
const stubCleanupSpawn = async () => 0;
const stubIdentitySpawn = async () => ({ value: '', exitCode: 1 });
const stubIdentityPrompt = async () => undefined;
const stubCredentialsSpawn = async () => ({ stdout: '', exitCode: 1 });

const baseRunOpts = {
  cliVersion: '0.0.0',
  logger: silentLogger,
  devcontainerSpawn: stubDevcontainerSpawn,
  cleanupSpawn: stubCleanupSpawn,
  identitySpawn: stubIdentitySpawn,
  identityPrompt: stubIdentityPrompt,
  credentialsSpawn: stubCredentialsSpawn,
};

describe('runApply', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-apply-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeYml(name: string, body: string): Promise<void> {
    await writeFile(path.join(home, 'container-configs', `${name}.yml`), body);
  }

  it('materializes into <home>/container/<name>/ by convention', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runApply({
      ...baseRunOpts,
      name: 'demo',
      monocerosHome: home,
    });

    const expected = path.join(home, 'container', 'demo');
    expect(result.targetDir).toBe(expected);
    expect(result.containerExitCode).toBe(0);

    const devcontainer = JSON.parse(
      await readFile(
        path.join(expected, '.devcontainer', 'devcontainer.json'),
        'utf8',
      ),
    );
    expect(devcontainer.name).toBe('demo');
    expect(devcontainer.image).toBe('monoceros-runtime:dev');

    const state = await readStateFile(expected);
    expect(state?.origin).toBe('demo');
    expect(state?.schemaVersion).toBe(1);
  });

  it('materializes a compose-mode scaffold when services are configured', async () => {
    await writeYml(
      'pgdemo',
      [
        'schemaVersion: 1',
        'name: pgdemo',
        'services:',
        '  - postgres',
        '',
      ].join('\n'),
    );
    await runApply({ ...baseRunOpts, name: 'pgdemo', monocerosHome: home });

    const composeText = await readFile(
      path.join(home, 'container', 'pgdemo', '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    expect(composeText).toContain('postgres:');
  });

  it('records cliVersion and timestamp in state.json', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApply({
      ...baseRunOpts,
      name: 'demo',
      monocerosHome: home,
      cliVersion: '1.2.3',
      now: new Date('2026-05-16T10:00:00Z'),
    });
    const state = await readStateFile(path.join(home, 'container', 'demo'));
    expect(state).toEqual({
      schemaVersion: 1,
      origin: 'demo',
      monocerosCliVersion: '1.2.3',
      materializedAt: '2026-05-16T10:00:00.000Z',
    });
  });

  it('overwrites scaffold files when re-applying the same origin', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });

    await writeYml(
      'demo',
      ['schemaVersion: 1', 'name: demo', 'services:', '  - redis', ''].join(
        '\n',
      ),
    );
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });

    const composeText = await readFile(
      path.join(home, 'container', 'demo', '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    expect(composeText).toContain('redis:');
  });

  it('removes a stale compose.yaml when services are dropped on re-apply', async () => {
    await writeYml(
      'demo',
      ['schemaVersion: 1', 'name: demo', 'services:', '  - postgres', ''].join(
        '\n',
      ),
    );
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });
    await expect(
      readFile(
        path.join(home, 'container', 'demo', '.devcontainer', 'compose.yaml'),
      ),
    ).rejects.toThrow();
  });

  it('errors when the config does not exist', async () => {
    await expect(
      runApply({ ...baseRunOpts, name: 'missing', monocerosHome: home }),
    ).rejects.toThrow(/No such config.*missing\.yml/);
  });

  it('errors when the yml fails schema validation', async () => {
    await writeYml('demo', 'schemaVersion: 99\nname: demo\n');
    await expect(
      runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home }),
    ).rejects.toThrow(/schemaVersion/);
  });

  it('errors when an unknown language slips past shape validation', async () => {
    await writeYml(
      'demo',
      ['schemaVersion: 1', 'name: demo', 'languages:', '  - klingon', ''].join(
        '\n',
      ),
    );
    await expect(
      runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home }),
    ).rejects.toThrow(/Unknown language: klingon/);
  });

  it('refuses to materialize into a non-empty unrelated directory', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const targetDir = path.join(home, 'container', 'demo');
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, 'random.txt'), 'hi');
    await expect(
      runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home }),
    ).rejects.toThrow(/Refusing to materialize/);
  });

  it('rejects an invalid config name without touching disk', async () => {
    await expect(
      runApply({ ...baseRunOpts, name: 'has space', monocerosHome: home }),
    ).rejects.toThrow(/Invalid config name/);
  });
});
