import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCreate } from '../src/create/index.js';
import type { StackFile } from '../src/create/types.js';
import { runAddLanguage, runAddService } from '../src/modify/index.js';

const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
};

const baseModifyOpts = {
  cliVersion: '0.1.0-dev',
  logger: silentLogger,
  output: () => {},
  yes: true,
};

async function scaffold(
  cwd: string,
  opts: {
    name: string;
    languages?: string[];
    services?: string[];
    postgresUrl?: string;
  },
): Promise<string> {
  await runCreate(
    {
      name: opts.name,
      languages: opts.languages ?? [],
      services: opts.services ?? [],
      postgresUrl: opts.postgresUrl,
    },
    {
      cwd,
      cliVersion: '0.1.0-dev',
      logger: { success: () => {}, info: () => {} },
    },
  );
  return path.join(cwd, opts.name);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

describe('runAddLanguage', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'monoceros-add-language-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('adds a feature to a bare image-mode solution', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    const result = await runAddLanguage({
      ...baseModifyOpts,
      cwd: solution,
      language: 'python',
    });
    expect(result.status).toBe('updated');

    const devcontainer = await readJson<{
      features?: Record<string, unknown>;
    }>(path.join(solution, '.devcontainer', 'devcontainer.json'));
    expect(devcontainer.features).toEqual({
      'ghcr.io/devcontainers/features/python:1': {},
    });

    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.languages).toEqual(['python']);
  });

  it('is a no-op when the language is already declared', async () => {
    const solution = await scaffold(cwd, {
      name: 'demo',
      languages: ['python'],
    });
    const stackBefore = await fs.readFile(
      path.join(solution, '.monoceros', 'stack.json'),
      'utf8',
    );

    const result = await runAddLanguage({
      ...baseModifyOpts,
      cwd: solution,
      language: 'python',
    });
    expect(result.status).toBe('no-change');

    expect(
      await fs.readFile(
        path.join(solution, '.monoceros', 'stack.json'),
        'utf8',
      ),
    ).toBe(stackBefore);
  });

  it('rejects unknown languages', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await expect(
      runAddLanguage({
        ...baseModifyOpts,
        cwd: solution,
        language: 'cobol',
      }),
    ).rejects.toThrow(/Unknown language: cobol/);
  });

  it('preserves createdAt and bumps cliVersion', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    const stackBefore = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );

    await runAddLanguage({
      ...baseModifyOpts,
      cwd: solution,
      language: 'python',
      cliVersion: '9.9.9-test',
    });

    const stackAfter = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stackAfter.createdAt).toBe(stackBefore.createdAt);
    expect(stackAfter.monocerosCliVersion).toBe('9.9.9-test');
  });

  it('respects an explicit no on the confirmation prompt', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    const result = await runAddLanguage({
      ...baseModifyOpts,
      cwd: solution,
      yes: false,
      confirm: async () => false,
      language: 'python',
    });
    expect(result.status).toBe('aborted');

    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.languages).toEqual([]);
  });

  it('emits a unified diff in the preview output', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    const lines: string[] = [];

    await runAddLanguage({
      ...baseModifyOpts,
      cwd: solution,
      language: 'python',
      output: (line) => lines.push(line),
    });

    const combined = lines.join('\n');
    expect(combined).toMatch(/devcontainer\.json/);
    expect(combined).toContain('"ghcr.io/devcontainers/features/python:1": {}');
  });
});

describe('runAddService', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'monoceros-add-service-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('promotes an image-mode solution to compose-mode and writes compose.yaml', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    const result = await runAddService({
      ...baseModifyOpts,
      cwd: solution,
      service: 'postgres',
    });
    expect(result.status).toBe('updated');

    const devcontainer = await readJson<{
      image?: string;
      dockerComposeFile?: string;
      service?: string;
      runServices?: string[];
    }>(path.join(solution, '.devcontainer', 'devcontainer.json'));
    expect(devcontainer.image).toBeUndefined();
    expect(devcontainer.dockerComposeFile).toBe('compose.yaml');
    expect(devcontainer.service).toBe('workspace');
    expect(devcontainer.runServices).toEqual(['postgres']);

    const compose = await fs.readFile(
      path.join(solution, '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    expect(compose).toContain('image: postgres:18');
  });

  it('appends another service to an existing compose.yaml', async () => {
    const solution = await scaffold(cwd, {
      name: 'demo',
      services: ['postgres'],
    });

    await runAddService({
      ...baseModifyOpts,
      cwd: solution,
      service: 'redis',
    });

    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.services).toEqual(['postgres', 'redis']);

    const compose = await fs.readFile(
      path.join(solution, '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    expect(compose).toContain('image: postgres:18');
    expect(compose).toContain('image: redis:8');
  });

  it('is a no-op when the service is already declared', async () => {
    const solution = await scaffold(cwd, {
      name: 'demo',
      services: ['postgres'],
    });
    const composeBefore = await fs.readFile(
      path.join(solution, '.devcontainer', 'compose.yaml'),
      'utf8',
    );

    const result = await runAddService({
      ...baseModifyOpts,
      cwd: solution,
      service: 'postgres',
    });
    expect(result.status).toBe('no-change');

    expect(
      await fs.readFile(
        path.join(solution, '.devcontainer', 'compose.yaml'),
        'utf8',
      ),
    ).toBe(composeBefore);
  });

  it('rejects unknown services', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await expect(
      runAddService({
        ...baseModifyOpts,
        cwd: solution,
        service: 'mongodb',
      }),
    ).rejects.toThrow(/Unknown service: mongodb/);
  });

  it('refuses solutions without a stack.json', async () => {
    const orphan = path.join(cwd, 'orphan');
    await fs.mkdir(path.join(orphan, '.devcontainer'), { recursive: true });

    await expect(
      runAddService({
        ...baseModifyOpts,
        cwd: orphan,
        service: 'postgres',
      }),
    ).rejects.toThrow(/No \.monoceros\/stack\.json at/);
  });
});
