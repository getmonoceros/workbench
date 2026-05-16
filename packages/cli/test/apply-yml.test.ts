import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runApplyFromYml } from '../src/apply/index.js';
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

async function makeWorkbench(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'monoceros-apply-yml-'));
  const yml = path.join(root, 'templates', 'yml');
  await mkdir(yml, { recursive: true });
  // README.md is the marker workbenchRoot() looks for. We don't use
  // workbenchRoot() in these tests (we inject it), but keep the file
  // for parity with the real layout.
  await writeFile(path.join(yml, 'README.md'), '# templates\n');
  await mkdir(path.join(root, '.local', 'container-configs'), {
    recursive: true,
  });
  return root;
}

describe('runApplyFromYml', () => {
  let workbench: string;
  let targetDir: string;

  beforeEach(async () => {
    workbench = await makeWorkbench();
    targetDir = path.join(workbench, '.local', 'play', 'sandbox');
  });

  afterEach(async () => {
    await rm(workbench, { recursive: true, force: true });
  });

  async function writeYml(name: string, body: string): Promise<void> {
    await writeFile(
      path.join(workbench, '.local', 'container-configs', `${name}.yml`),
      body,
    );
  }

  it('materializes a bare image-mode scaffold into an empty target dir', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runApplyFromYml({
      ...baseRunOpts,
      name: 'demo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });

    expect(result.containerExitCode).toBe(0);
    expect(result.targetDir).toBe(targetDir);

    const devcontainer = JSON.parse(
      await readFile(
        path.join(targetDir, '.devcontainer', 'devcontainer.json'),
        'utf8',
      ),
    );
    expect(devcontainer.name).toBe('demo');
    expect(devcontainer.image).toBe('monoceros-runtime:dev');

    const state = await readStateFile(targetDir);
    expect(state?.origin).toBe('demo');
    expect(state?.schemaVersion).toBe(1);

    // README is only written by `runCreate`, not by re-apply.
    await expect(readFile(path.join(targetDir, 'README.md'))).rejects.toThrow();
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
    await runApplyFromYml({
      ...baseRunOpts,
      name: 'pgdemo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });

    const composeText = await readFile(
      path.join(targetDir, '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    expect(composeText).toContain('postgres:');
  });

  it('writes a state.json with cli version and origin', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApplyFromYml({
      ...baseRunOpts,
      name: 'demo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
      cliVersion: '1.2.3',
      now: new Date('2026-05-16T10:00:00Z'),
    });
    const state = await readStateFile(targetDir);
    expect(state).toEqual({
      schemaVersion: 1,
      origin: 'demo',
      monocerosCliVersion: '1.2.3',
      materializedAt: '2026-05-16T10:00:00.000Z',
    });
  });

  it('overwrites a previous scaffold when re-applying the same origin', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApplyFromYml({
      ...baseRunOpts,
      name: 'demo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });

    // Add a service to the yml and re-apply.
    await writeYml(
      'demo',
      ['schemaVersion: 1', 'name: demo', 'services:', '  - redis', ''].join(
        '\n',
      ),
    );
    await runApplyFromYml({
      ...baseRunOpts,
      name: 'demo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });

    const composeText = await readFile(
      path.join(targetDir, '.devcontainer', 'compose.yaml'),
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
    await runApplyFromYml({
      ...baseRunOpts,
      name: 'demo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApplyFromYml({
      ...baseRunOpts,
      name: 'demo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });
    await expect(
      readFile(path.join(targetDir, '.devcontainer', 'compose.yaml')),
    ).rejects.toThrow();
  });

  it('errors when the config does not exist', async () => {
    await expect(
      runApplyFromYml({
        ...baseRunOpts,
        name: 'missing',
        targetDir,
        monocerosHome: path.join(workbench, '.local'),
      }),
    ).rejects.toThrow(/No such config.*missing\.yml/);
  });

  it('errors when the yml fails schema validation', async () => {
    await writeYml('demo', 'schemaVersion: 99\nname: demo\n');
    await expect(
      runApplyFromYml({
        ...baseRunOpts,
        name: 'demo',
        targetDir,
        monocerosHome: path.join(workbench, '.local'),
      }),
    ).rejects.toThrow(/schemaVersion/);
  });

  it('errors when an unknown language slips past shape validation', async () => {
    // The catalog (create/scaffold.ts) rejects languages not in
    // BUILTIN_LANGUAGES ∪ LANGUAGE_CATALOG. Schema accepts any
    // non-empty string, so this surfaces only at apply.
    await writeYml(
      'demo',
      ['schemaVersion: 1', 'name: demo', 'languages:', '  - klingon', ''].join(
        '\n',
      ),
    );
    await expect(
      runApplyFromYml({
        ...baseRunOpts,
        name: 'demo',
        targetDir,
        monocerosHome: path.join(workbench, '.local'),
      }),
    ).rejects.toThrow(/Unknown language: klingon/);
  });

  it('refuses to materialize into a non-empty unrelated directory', async () => {
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, 'random.txt'), 'hi');
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runApplyFromYml({
        ...baseRunOpts,
        name: 'demo',
        targetDir,
        monocerosHome: path.join(workbench, '.local'),
      }),
    ).rejects.toThrow(/Refusing to materialize/);
  });

  it('refuses to re-apply when state.json points at a different origin', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await writeYml('other', 'schemaVersion: 1\nname: other\n');
    await runApplyFromYml({
      ...baseRunOpts,
      name: 'demo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });
    await expect(
      runApplyFromYml({
        ...baseRunOpts,
        name: 'other',
        targetDir,
        monocerosHome: path.join(workbench, '.local'),
      }),
    ).rejects.toThrow(/already materialized from config 'demo'/);
  });

  it('errors when a legacy stack.json sits in the target dir', async () => {
    await mkdir(path.join(targetDir, '.monoceros'), { recursive: true });
    await writeFile(
      path.join(targetDir, '.monoceros', 'stack.json'),
      JSON.stringify({ name: 'legacy' }),
    );
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runApplyFromYml({
        ...baseRunOpts,
        name: 'demo',
        targetDir,
        monocerosHome: path.join(workbench, '.local'),
      }),
    ).rejects.toThrow(/legacy stack\.json/);
  });

  it('rejects an invalid config name without touching disk', async () => {
    await expect(
      runApplyFromYml({
        ...baseRunOpts,
        name: 'has space',
        targetDir,
        monocerosHome: path.join(workbench, '.local'),
      }),
    ).rejects.toThrow(/Invalid config name/);
  });
});
