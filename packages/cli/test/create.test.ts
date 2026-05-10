import { promises as fs } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCreate } from '../src/create/index.js';
import type { StackFile } from '../src/create/types.js';

const silentLogger = {
  success: () => {},
  info: () => {},
};

const baseRunOpts = {
  cliVersion: '0.0.0',
  logger: silentLogger,
};

describe('runCreate', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'monoceros-create-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('scaffolds a bare solution with devcontainer, stack.json and README', async () => {
    const result = await runCreate(
      { name: 'demo', languages: [], services: [] },
      { ...baseRunOpts, cwd },
    );

    expect(result.status).toBe('created');
    const target = path.join(cwd, 'demo');

    const devcontainer = JSON.parse(
      await readFile(
        path.join(target, '.devcontainer', 'devcontainer.json'),
        'utf8',
      ),
    );
    expect(devcontainer.image).toBe('monoceros-runtime:dev');
    expect(devcontainer.runArgs).toEqual(['--cap-add=NET_ADMIN']);
    expect(devcontainer.dockerComposeFile).toBeUndefined();
    expect(devcontainer.features).toBeUndefined();
    expect(devcontainer.mounts).toContain(
      'source=${localEnv:HOME}/.claude,target=/home/node/.claude,type=bind,consistency=cached',
    );
    expect(devcontainer.customizations?.vscode?.extensions).toContain(
      'anthropic.claude-code',
    );

    const postCreate = await readFile(
      path.join(target, '.devcontainer', 'post-create.sh'),
      'utf8',
    );
    // Claude CLI is preinstalled in the runtime image, so post-create
    // no longer installs it. pnpm install stays for Node solutions.
    expect(postCreate).not.toContain('@anthropic-ai/claude-code');
    expect(postCreate).toContain('pnpm install');

    const stat = await fs.stat(
      path.join(target, '.devcontainer', 'post-create.sh'),
    );
    expect(stat.mode & 0o111).not.toBe(0);

    const stack: StackFile = JSON.parse(
      await readFile(path.join(target, '.monoceros', 'stack.json'), 'utf8'),
    );
    expect(stack).toMatchObject({
      name: 'demo',
      languages: [],
      services: [],
      externalServices: {},
      monocerosCliVersion: '0.0.0',
    });

    const readme = await readFile(path.join(target, 'README.md'), 'utf8');
    expect(readme).toMatch(/^# demo/);

    expect(
      await pathExists(path.join(target, '.devcontainer', 'compose.yaml')),
    ).toBe(false);
  });

  it('adds devcontainer features for declared languages and skips node', async () => {
    await runCreate(
      { name: 'demo', languages: ['python', 'node'], services: [] },
      { ...baseRunOpts, cwd },
    );

    const devcontainer = JSON.parse(
      await readFile(
        path.join(cwd, 'demo', '.devcontainer', 'devcontainer.json'),
        'utf8',
      ),
    );
    expect(devcontainer.features).toEqual({
      'ghcr.io/devcontainers/features/python:1': {},
    });
  });

  it('switches to compose mode and writes compose.yaml when services are selected', async () => {
    await runCreate(
      { name: 'demo', languages: [], services: ['postgres'] },
      { ...baseRunOpts, cwd },
    );

    const devcontainer = JSON.parse(
      await readFile(
        path.join(cwd, 'demo', '.devcontainer', 'devcontainer.json'),
        'utf8',
      ),
    );
    expect(devcontainer).toMatchObject({
      dockerComposeFile: 'compose.yaml',
      service: 'workspace',
      runServices: ['postgres'],
      workspaceFolder: '/workspaces/demo',
    });
    expect(devcontainer.image).toBeUndefined();
    expect(devcontainer.mounts).toBeUndefined();

    const compose = await readFile(
      path.join(cwd, 'demo', '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    expect(compose).toContain('workspace:');
    expect(compose).toContain('image: monoceros-runtime:dev');
    expect(compose).toContain('cap_add:');
    expect(compose).toContain('- NET_ADMIN');
    // No `user: node` line — the entrypoint drops to node via gosu.
    expect(compose).not.toMatch(/^\s*user:\s+node/m);
    expect(compose).toContain('postgres:');
    expect(compose).toContain('image: postgres:18');
    expect(compose).toContain('postgres-data:');
  });

  it('omits the postgres compose service when --postgres-url is provided', async () => {
    await runCreate(
      {
        name: 'demo',
        languages: [],
        services: ['postgres'],
        postgresUrl: 'postgres://example.com/db',
      },
      { ...baseRunOpts, cwd },
    );

    const stack: StackFile = JSON.parse(
      await readFile(
        path.join(cwd, 'demo', '.monoceros', 'stack.json'),
        'utf8',
      ),
    );
    expect(stack.services).toEqual([]);
    expect(stack.externalServices).toEqual({
      postgres: 'postgres://example.com/db',
    });

    expect(
      await pathExists(path.join(cwd, 'demo', '.devcontainer', 'compose.yaml')),
    ).toBe(false);
  });

  it('is a no-op when re-run with identical options', async () => {
    const opts = { name: 'demo', languages: ['python'], services: [] };
    const first = await runCreate(opts, { ...baseRunOpts, cwd });
    expect(first.status).toBe('created');

    const stackPath = path.join(cwd, 'demo', '.monoceros', 'stack.json');
    const stackBefore = await readFile(stackPath, 'utf8');

    const second = await runCreate(opts, { ...baseRunOpts, cwd });
    expect(second.status).toBe('already-up-to-date');

    expect(await readFile(stackPath, 'utf8')).toBe(stackBefore);
  });

  it('refuses to re-run with conflicting options', async () => {
    await runCreate(
      { name: 'demo', languages: [], services: [] },
      { ...baseRunOpts, cwd },
    );

    await expect(
      runCreate(
        { name: 'demo', languages: ['python'], services: [] },
        { ...baseRunOpts, cwd },
      ),
    ).rejects.toThrow(/different options/);
  });

  it('refuses to scaffold into a non-empty directory without stack.json', async () => {
    const target = path.join(cwd, 'demo');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'unrelated.txt'), 'hi');

    await expect(
      runCreate(
        { name: 'demo', languages: [], services: [] },
        { ...baseRunOpts, cwd },
      ),
    ).rejects.toThrow(/non-empty directory/);
  });

  it('rejects unknown languages and services', async () => {
    await expect(
      runCreate(
        { name: 'demo', languages: ['cobol'], services: [] },
        { ...baseRunOpts, cwd },
      ),
    ).rejects.toThrow(/Unknown language: cobol/);

    await expect(
      runCreate(
        { name: 'demo', languages: [], services: ['mongodb'] },
        { ...baseRunOpts, cwd },
      ),
    ).rejects.toThrow(/Unknown service: mongodb/);
  });

  it('rejects invalid solution names', async () => {
    await expect(
      runCreate(
        { name: '../escape', languages: [], services: [] },
        { ...baseRunOpts, cwd },
      ),
    ).rejects.toThrow(/Invalid solution name/);
  });
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
