import { existsSync, promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runApplyFromCwd } from '../src/apply/index.js';
import { parseConfig } from '../src/config/io.js';
import { readStateFile } from '../src/config/state.js';
import type { StackFile } from '../src/create/types.js';

const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
};

const baseRunOpts = {
  cliVersion: '0.0.0',
  logger: silentLogger,
  devcontainerSpawn: async () => 0,
  cleanupSpawn: async () => 0,
  identitySpawn: async () => ({ value: '', exitCode: 1 }),
  identityPrompt: async () => undefined,
  credentialsSpawn: async () => ({ stdout: '', exitCode: 1 }),
};

let workbench: string;

beforeEach(() => {
  workbench = mkdtempSync(path.join(tmpdir(), 'monoceros-migration-'));
});
afterEach(() => {
  if (workbench && existsSync(workbench)) {
    rmSync(workbench, { recursive: true, force: true });
  }
});

async function makeLegacySolution(
  name: string,
  stack: StackFile,
): Promise<string> {
  const solutionRoot = path.join(workbench, '.local', 'play', name);
  await mkdir(path.join(solutionRoot, '.devcontainer'), { recursive: true });
  await mkdir(path.join(solutionRoot, '.monoceros'), { recursive: true });
  // Minimum: devcontainer.json (so findSolutionRoot succeeds) + stack.json
  await writeFile(
    path.join(solutionRoot, '.devcontainer', 'devcontainer.json'),
    JSON.stringify({ name, image: 'monoceros-runtime:dev' }),
  );
  await writeFile(
    path.join(solutionRoot, '.monoceros', 'stack.json'),
    JSON.stringify(stack, null, 2) + '\n',
  );
  return solutionRoot;
}

describe('stack.json → yml migration on first apply', () => {
  it('seeds a yml from a minimal stack.json and archives the legacy file', async () => {
    const solution = await makeLegacySolution('demo', {
      name: 'demo',
      createdAt: '2026-01-01T00:00:00.000Z',
      monocerosCliVersion: '0.0.0',
      languages: [],
      services: [],
      externalServices: {},
    });

    const exit = await runApplyFromCwd({
      ...baseRunOpts,
      cwd: solution,
      workbenchRoot: workbench,
    });
    expect(exit).toBe(0);

    // yml seeded from stack.
    const yml = await fs.readFile(
      path.join(workbench, '.local', 'container-configs', 'demo.yml'),
      'utf8',
    );
    const parsed = parseConfig(yml);
    expect(parsed.config.name).toBe('demo');

    // state.json written.
    const state = await readStateFile(solution);
    expect(state?.origin).toBe('demo');

    // Legacy stack.json archived in place.
    await expect(
      fs.access(path.join(solution, '.monoceros', 'stack.json')),
    ).rejects.toThrow();
    const legacyText = await fs.readFile(
      path.join(solution, '.monoceros', 'stack.json.legacy'),
      'utf8',
    );
    expect(JSON.parse(legacyText)).toMatchObject({ name: 'demo' });
  });

  it('preserves languages, services, apt packages, features, install URLs and repos', async () => {
    const solution = await makeLegacySolution('rich', {
      name: 'rich',
      createdAt: '2026-01-01T00:00:00.000Z',
      monocerosCliVersion: '0.0.0',
      languages: ['python'],
      services: ['postgres'],
      externalServices: {},
      aptPackages: ['jq', 'make'],
      features: {
        'ghcr.io/devcontainers/features/docker-in-docker:2': {
          version: 'latest',
        },
      },
      installUrls: ['https://example.com/install.sh'],
      repos: [{ url: 'git@github.com:foo/bar.git', name: 'bar' }],
    });

    await runApplyFromCwd({
      ...baseRunOpts,
      cwd: solution,
      workbenchRoot: workbench,
    });

    const yml = await fs.readFile(
      path.join(workbench, '.local', 'container-configs', 'rich.yml'),
      'utf8',
    );
    const parsed = parseConfig(yml);
    expect(parsed.config.languages).toEqual(['python']);
    expect(parsed.config.services).toEqual(['postgres']);
    expect(parsed.config.aptPackages).toEqual(['jq', 'make']);
    expect(parsed.config.features).toEqual([
      {
        ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
        options: { version: 'latest' },
      },
    ]);
    expect(parsed.config.installUrls).toEqual([
      'https://example.com/install.sh',
    ]);
    // URL-derived name is dropped from the yml; only non-default names persist.
    expect(parsed.config.repos).toEqual([
      { url: 'git@github.com:foo/bar.git' },
    ]);
  });

  it('preserves externalServices.postgres', async () => {
    const solution = await makeLegacySolution('extdb', {
      name: 'extdb',
      createdAt: '2026-01-01T00:00:00.000Z',
      monocerosCliVersion: '0.0.0',
      languages: [],
      services: [],
      externalServices: { postgres: 'postgresql://user:pw@host:5432/db' },
    });
    await runApplyFromCwd({
      ...baseRunOpts,
      cwd: solution,
      workbenchRoot: workbench,
    });
    const yml = await fs.readFile(
      path.join(workbench, '.local', 'container-configs', 'extdb.yml'),
      'utf8',
    );
    expect(yml).toContain('postgresql://user:pw@host:5432/db');
  });

  it('second apply skips migration and routes via state.json', async () => {
    const solution = await makeLegacySolution('demo', {
      name: 'demo',
      createdAt: '2026-01-01T00:00:00.000Z',
      monocerosCliVersion: '0.0.0',
      languages: [],
      services: [],
      externalServices: {},
    });
    await runApplyFromCwd({
      ...baseRunOpts,
      cwd: solution,
      workbenchRoot: workbench,
    });
    // Touch the yml so we can prove the second apply re-reads it.
    const ymlPath = path.join(
      workbench,
      '.local',
      'container-configs',
      'demo.yml',
    );
    const oldYml = await fs.readFile(ymlPath, 'utf8');
    await fs.writeFile(ymlPath, oldYml + 'aptPackages:\n  - curl\n');

    await runApplyFromCwd({
      ...baseRunOpts,
      cwd: solution,
      workbenchRoot: workbench,
    });
    const devcontainer = JSON.parse(
      await fs.readFile(
        path.join(solution, '.devcontainer', 'devcontainer.json'),
        'utf8',
      ),
    );
    // devcontainer.json regenerated from the edited yml — the apt-
    // packages feature shows up now even though the legacy stack had
    // no aptPackages.
    expect(devcontainer.features).toEqual({
      'ghcr.io/devcontainers-contrib/features/apt-packages:1': {
        packages: 'curl',
      },
    });

    // stack.json.legacy still in place; not re-archived.
    await expect(
      fs.access(path.join(solution, '.monoceros', 'stack.json.legacy')),
    ).resolves.toBeUndefined();
  });

  it('errors if a yml with the same name already exists', async () => {
    // Pre-existing yml — builder ran `monoceros init` earlier.
    await mkdir(path.join(workbench, '.local', 'container-configs'), {
      recursive: true,
    });
    await writeFile(
      path.join(workbench, '.local', 'container-configs', 'collide.yml'),
      'schemaVersion: 1\nname: collide\n',
    );
    const solution = await makeLegacySolution('collide', {
      name: 'collide',
      createdAt: '2026-01-01T00:00:00.000Z',
      monocerosCliVersion: '0.0.0',
      languages: [],
      services: [],
      externalServices: {},
    });
    await expect(
      runApplyFromCwd({
        ...baseRunOpts,
        cwd: solution,
        workbenchRoot: workbench,
      }),
    ).rejects.toThrow(/Migration aborted.*already exists/);

    // No mutation on the legacy solution if the migration aborted.
    await expect(
      fs.access(path.join(solution, '.monoceros', 'stack.json')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(solution, '.monoceros', 'stack.json.legacy')),
    ).rejects.toThrow();
  });
});
