import { existsSync, promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runAddAptPackages,
  runAddFeature,
  runAddFromUrl,
  runAddLanguage,
  runAddRepo,
  runAddService,
} from '../src/modify/index.js';

const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
};

const NEVER_PROMPT_CONFIRM = async () => true;
const NEVER_OUTPUT = () => {};

const baseOpts = {
  cliVersion: '0.0.0',
  yes: true,
  logger: silentLogger,
  confirm: NEVER_PROMPT_CONFIRM,
  output: NEVER_OUTPUT,
};

/**
 * Build a minimal Phase-3 workspace: workbench root with the yml at
 * `.local/container-configs/<name>.yml` and a solution dir at
 * `<workbench>/.local/play/<name>/` with `.devcontainer/` and
 * `.monoceros/state.json` pointing back at the yml.
 */
async function makeWorkspace(opts: {
  name: string;
  yml: string;
}): Promise<{ workbench: string; solutionRoot: string }> {
  const workbench = mkdtempSync(path.join(tmpdir(), 'monoceros-modify-yml-'));
  // Tests don't go through workbenchRoot() — we pass workbenchRoot
  // explicitly via opts — so a templates marker isn't strictly needed,
  // but keep it consistent with the real layout.
  await mkdir(path.join(workbench, 'templates', 'yml'), { recursive: true });
  await writeFile(path.join(workbench, 'templates', 'yml', 'README.md'), '#\n');

  const configsDir = path.join(workbench, '.local', 'container-configs');
  await mkdir(configsDir, { recursive: true });
  await writeFile(path.join(configsDir, `${opts.name}.yml`), opts.yml);

  const solutionRoot = path.join(workbench, '.local', 'play', opts.name);
  await mkdir(path.join(solutionRoot, '.devcontainer'), { recursive: true });
  await mkdir(path.join(solutionRoot, '.monoceros'), { recursive: true });
  // Empty devcontainer.json — just needs to exist for findSolutionRoot.
  await writeFile(
    path.join(solutionRoot, '.devcontainer', 'devcontainer.json'),
    '{}',
  );
  await writeFile(
    path.join(solutionRoot, '.monoceros', 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      origin: opts.name,
      monocerosCliVersion: '0.0.0',
      materializedAt: '2026-05-16T00:00:00.000Z',
    }),
  );
  return { workbench, solutionRoot };
}

async function ymlOf(workbench: string, name: string): Promise<string> {
  return fs.readFile(
    path.join(workbench, '.local', 'container-configs', `${name}.yml`),
    'utf8',
  );
}

describe('add-* via state.json (Phase-3 path)', () => {
  let workbench: string;
  let solutionRoot: string;

  afterEach(() => {
    if (workbench && existsSync(workbench)) {
      rmSync(workbench, { recursive: true, force: true });
    }
  });

  async function setup(yml: string, name = 'demo'): Promise<void> {
    const ws = await makeWorkspace({ name, yml });
    workbench = ws.workbench;
    solutionRoot = ws.solutionRoot;
  }

  it('runAddLanguage edits the yml and leaves container files alone', async () => {
    await setup('# my notes\nschemaVersion: 1\nname: demo\n');
    const result = await runAddLanguage({
      ...baseOpts,
      language: 'python',
      cwd: solutionRoot,
      workbenchRoot: workbench,
    });

    expect(result.status).toBe('updated');
    const yml = await ymlOf(workbench, 'demo');
    expect(yml).toContain('# my notes'); // comment preserved
    expect(yml).toContain('languages:');
    expect(yml).toContain('- python');

    // Container files NOT touched — Phase 3 defers materialization to
    // `monoceros apply`.
    const devcontainerText = await fs.readFile(
      path.join(solutionRoot, '.devcontainer', 'devcontainer.json'),
      'utf8',
    );
    expect(devcontainerText).toBe('{}');
  });

  it('runAddService is idempotent when the service is already present', async () => {
    await setup(
      ['schemaVersion: 1', 'name: demo', 'services:', '  - postgres', ''].join(
        '\n',
      ),
    );
    const result = await runAddService({
      ...baseOpts,
      service: 'postgres',
      cwd: solutionRoot,
      workbenchRoot: workbench,
    });
    expect(result.status).toBe('no-change');
  });

  it('runAddAptPackages appends only the new packages, preserving comments', async () => {
    await setup(
      [
        'schemaVersion: 1',
        'name: demo',
        'aptPackages:',
        '  - make # build essential',
        '  - jq',
        '',
      ].join('\n'),
    );
    const result = await runAddAptPackages({
      ...baseOpts,
      packages: ['jq', 'curl'],
      cwd: solutionRoot,
      workbenchRoot: workbench,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf(workbench, 'demo');
    expect(yml).toContain('# build essential');
    expect(yml).toContain('- curl');
    // jq already present → only one entry, not duplicated.
    expect(yml.match(/- jq\b/g)).toHaveLength(1);
  });

  it('runAddFromUrl appends to installUrls', async () => {
    await setup('schemaVersion: 1\nname: demo\n');
    await runAddFromUrl({
      ...baseOpts,
      url: 'https://example.com/install',
      cwd: solutionRoot,
      workbenchRoot: workbench,
    });
    const yml = await ymlOf(workbench, 'demo');
    expect(yml).toContain('installUrls:');
    expect(yml).toContain('- https://example.com/install');
  });

  it('runAddFeature writes a structured entry with options', async () => {
    await setup('schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      options: { version: 'latest' },
      cwd: solutionRoot,
      workbenchRoot: workbench,
    });
    const yml = await ymlOf(workbench, 'demo');
    expect(yml).toContain(
      '- ref: ghcr.io/devcontainers/features/docker-in-docker:2',
    );
    expect(yml).toContain('options:');
    expect(yml).toContain('version: latest');
  });

  it('runAddFeature errors when re-adding with different options', async () => {
    await setup('schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      options: { version: 'latest' },
      cwd: solutionRoot,
      workbenchRoot: workbench,
    });
    await expect(
      runAddFeature({
        ...baseOpts,
        ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
        options: { version: '20.10' },
        cwd: solutionRoot,
        workbenchRoot: workbench,
      }),
    ).rejects.toThrow(/different options/);
  });

  it('runAddRepo appends a repo entry, omitting redundant name', async () => {
    await setup('schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      url: 'git@github.com:foo/bar.git',
      cwd: solutionRoot,
      workbenchRoot: workbench,
    });
    const yml = await ymlOf(workbench, 'demo');
    expect(yml).toContain('repos:');
    expect(yml).toContain('- url: git@github.com:foo/bar.git');
    // name was derived from URL → not persisted as a redundant field.
    expect(yml).not.toMatch(/name: bar\b/);
  });

  it('runAddRepo persists a non-default name', async () => {
    await setup('schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      url: 'https://github.com/foo/bar.git',
      name: 'ui',
      cwd: solutionRoot,
      workbenchRoot: workbench,
    });
    const yml = await ymlOf(workbench, 'demo');
    expect(yml).toContain('name: ui');
  });

  it('aborts cleanly when the user declines the prompt', async () => {
    await setup('schemaVersion: 1\nname: demo\n');
    const result = await runAddLanguage({
      ...baseOpts,
      yes: false,
      confirm: async () => false,
      language: 'python',
      cwd: solutionRoot,
      workbenchRoot: workbench,
    });
    expect(result.status).toBe('aborted');
    const yml = await ymlOf(workbench, 'demo');
    expect(yml).not.toContain('python');
  });

  it('errors when state.json points at a missing yml', async () => {
    await setup('schemaVersion: 1\nname: demo\n');
    await fs.unlink(
      path.join(workbench, '.local', 'container-configs', 'demo.yml'),
    );
    await expect(
      runAddLanguage({
        ...baseOpts,
        language: 'python',
        cwd: solutionRoot,
        workbenchRoot: workbench,
      }),
    ).rejects.toThrow(/no yml/);
  });
});
