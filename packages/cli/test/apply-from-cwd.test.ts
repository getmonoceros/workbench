import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runApplyFromCwd, runApplyFromYml } from '../src/apply/index.js';

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
  const root = await mkdtemp(path.join(tmpdir(), 'monoceros-apply-cwd-'));
  await mkdir(path.join(root, 'templates', 'yml'), { recursive: true });
  await writeFile(path.join(root, 'templates', 'yml', 'README.md'), '#\n');
  await mkdir(path.join(root, '.local', 'container-configs'), {
    recursive: true,
  });
  return root;
}

describe('runApplyFromCwd', () => {
  let workbench: string;

  beforeEach(async () => {
    workbench = await makeWorkbench();
  });

  afterEach(async () => {
    await rm(workbench, { recursive: true, force: true });
  });

  it('re-applies a state.json-backed solution against its origin yml', async () => {
    // First materialize via the yml path…
    await writeFile(
      path.join(workbench, '.local', 'container-configs', 'demo.yml'),
      'schemaVersion: 1\nname: demo\n',
    );
    const targetDir = path.join(workbench, '.local', 'play', 'demo-cwd');
    await runApplyFromYml({
      ...baseRunOpts,
      name: 'demo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });

    // …then edit the yml and run apply (no args) from inside the target.
    await writeFile(
      path.join(workbench, '.local', 'container-configs', 'demo.yml'),
      ['schemaVersion: 1', 'name: demo', 'services:', '  - redis', ''].join(
        '\n',
      ),
    );
    const exit = await runApplyFromCwd({
      ...baseRunOpts,
      cwd: targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });
    expect(exit).toBe(0);

    const compose = await readFile(
      path.join(targetDir, '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    expect(compose).toContain('redis:');
  });

  it('walks up from a sub-directory to find the solution root', async () => {
    await writeFile(
      path.join(workbench, '.local', 'container-configs', 'demo.yml'),
      'schemaVersion: 1\nname: demo\n',
    );
    const targetDir = path.join(workbench, '.local', 'play', 'walkup');
    await runApplyFromYml({
      ...baseRunOpts,
      name: 'demo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });
    const nested = path.join(targetDir, 'projects', 'whatever');
    await mkdir(nested, { recursive: true });
    const exit = await runApplyFromCwd({
      ...baseRunOpts,
      cwd: nested,
      monocerosHome: path.join(workbench, '.local'),
    });
    expect(exit).toBe(0);
  });

  it('migrates a legacy stack.json solution on first apply', async () => {
    // Mimic a legacy M1 solution: .devcontainer/ + stack.json, no state.json.
    // Detailed migration coverage lives in apply-migration.test.ts —
    // this case just asserts the dispatch routes through migration
    // rather than erroring.
    const targetDir = path.join(workbench, '.local', 'play', 'legacy');
    await mkdir(path.join(targetDir, '.devcontainer'), { recursive: true });
    await mkdir(path.join(targetDir, '.monoceros'), { recursive: true });
    await writeFile(
      path.join(targetDir, '.devcontainer', 'devcontainer.json'),
      JSON.stringify({ name: 'legacy', image: 'monoceros-runtime:dev' }),
    );
    await writeFile(
      path.join(targetDir, '.monoceros', 'stack.json'),
      JSON.stringify({
        name: 'legacy',
        createdAt: '2026-01-01T00:00:00.000Z',
        monocerosCliVersion: '0.0.0',
        languages: [],
        services: [],
        externalServices: {},
      }),
    );

    const exit = await runApplyFromCwd({
      ...baseRunOpts,
      cwd: targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });
    expect(exit).toBe(0);
  });

  it('errors when no .devcontainer/ is found at or above cwd', async () => {
    const orphan = path.join(workbench, '.local', 'play', 'orphan');
    await mkdir(orphan, { recursive: true });
    await expect(
      runApplyFromCwd({
        ...baseRunOpts,
        cwd: orphan,
        monocerosHome: path.join(workbench, '.local'),
      }),
    ).rejects.toThrow(/No \.devcontainer\/ found/);
  });

  it('propagates yml changes (e.g. add a repo) on re-apply', async () => {
    await writeFile(
      path.join(workbench, '.local', 'container-configs', 'demo.yml'),
      'schemaVersion: 1\nname: demo\n',
    );
    const targetDir = path.join(workbench, '.local', 'play', 'propagate');
    await runApplyFromYml({
      ...baseRunOpts,
      name: 'demo',
      targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });

    await writeFile(
      path.join(workbench, '.local', 'container-configs', 'demo.yml'),
      [
        'schemaVersion: 1',
        'name: demo',
        'repos:',
        '  - url: git@github.com:foo/bar.git',
        '',
      ].join('\n'),
    );
    await runApplyFromCwd({
      ...baseRunOpts,
      cwd: targetDir,
      monocerosHome: path.join(workbench, '.local'),
    });

    const postCreate = await readFile(
      path.join(targetDir, '.devcontainer', 'post-create.sh'),
      'utf8',
    );
    expect(postCreate).toContain('git clone "git@github.com:foo/bar.git"');
  });
});
