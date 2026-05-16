import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCreate } from '../src/create/index.js';
import type { StackFile } from '../src/create/types.js';
import { deriveRepoName } from '../src/create/scaffold.js';
import {
  runAddAptPackages,
  runAddFeature,
  runAddFromUrl,
  runAddLanguage,
  runAddRepo,
  runAddService,
  runRemoveAptPackages,
  runRemoveFeature,
  runRemoveLanguage,
  runRemoveRepo,
  runRemoveService,
} from '../src/modify/index.js';

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
      logger: { success: () => {}, info: () => {}, warn: () => {} },
      // Non-interactive — avoid `consola.prompt` hanging in test envs
      // where the user has no host-side global git identity.
      identityPrompt: async () => undefined,
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

describe('runAddAptPackages', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'monoceros-add-apt-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('adds the apt-packages feature to a bare solution and records the list in stack.json', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    const result = await runAddAptPackages({
      ...baseModifyOpts,
      cwd: solution,
      packages: ['make', 'jq'],
    });
    expect(result.status).toBe('updated');

    const devcontainer = await readJson<{
      features?: Record<string, Record<string, unknown>>;
    }>(path.join(solution, '.devcontainer', 'devcontainer.json'));
    expect(
      devcontainer.features?.[
        'ghcr.io/devcontainers-contrib/features/apt-packages:1'
      ],
    ).toEqual({ packages: 'jq,make' });

    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.aptPackages).toEqual(['jq', 'make']);
  });

  it('accumulates packages across multiple invocations (idempotent + sorted)', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await runAddAptPackages({
      ...baseModifyOpts,
      cwd: solution,
      packages: ['make'],
    });
    await runAddAptPackages({
      ...baseModifyOpts,
      cwd: solution,
      packages: ['jq', 'openssh-client'],
    });

    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.aptPackages).toEqual(['jq', 'make', 'openssh-client']);
  });

  it('is a no-op when every requested package is already declared', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddAptPackages({
      ...baseModifyOpts,
      cwd: solution,
      packages: ['make', 'jq'],
    });
    const stackBefore = await fs.readFile(
      path.join(solution, '.monoceros', 'stack.json'),
      'utf8',
    );

    const result = await runAddAptPackages({
      ...baseModifyOpts,
      cwd: solution,
      packages: ['jq', 'make'],
    });
    expect(result.status).toBe('no-change');

    expect(
      await fs.readFile(
        path.join(solution, '.monoceros', 'stack.json'),
        'utf8',
      ),
    ).toBe(stackBefore);
  });

  it('rejects invalid package names with shell metacharacters', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await expect(
      runAddAptPackages({
        ...baseModifyOpts,
        cwd: solution,
        packages: ['make; rm -rf /'],
      }),
    ).rejects.toThrow(/Invalid apt package name/);
  });

  it('rejects empty package list with a usage hint', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await expect(
      runAddAptPackages({
        ...baseModifyOpts,
        cwd: solution,
        packages: [],
      }),
    ).rejects.toThrow(/No package names given/);
  });

  it('respects an explicit no on the confirmation prompt', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    const result = await runAddAptPackages({
      ...baseModifyOpts,
      cwd: solution,
      yes: false,
      confirm: async () => false,
      packages: ['make'],
    });
    expect(result.status).toBe('aborted');

    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.aptPackages).toBeUndefined();
  });
});

describe('runAddFeature', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'monoceros-add-feature-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('writes the feature into devcontainer.json with the given options', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    const result = await runAddFeature({
      ...baseModifyOpts,
      cwd: solution,
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      options: { version: 'latest', moby: true },
    });
    expect(result.status).toBe('updated');

    const devcontainer = await readJson<{
      features?: Record<string, Record<string, unknown>>;
    }>(path.join(solution, '.devcontainer', 'devcontainer.json'));
    expect(
      devcontainer.features?.[
        'ghcr.io/devcontainers/features/docker-in-docker:2'
      ],
    ).toEqual({ version: 'latest', moby: true });

    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(
      stack.features?.['ghcr.io/devcontainers/features/docker-in-docker:2'],
    ).toEqual({ version: 'latest', moby: true });
  });

  it('is a no-op when re-added with identical options', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await runAddFeature({
      ...baseModifyOpts,
      cwd: solution,
      ref: 'ghcr.io/devcontainers/features/github-cli:1',
      options: {},
    });
    const stackBefore = await fs.readFile(
      path.join(solution, '.monoceros', 'stack.json'),
      'utf8',
    );

    const result = await runAddFeature({
      ...baseModifyOpts,
      cwd: solution,
      ref: 'ghcr.io/devcontainers/features/github-cli:1',
      options: {},
    });
    expect(result.status).toBe('no-change');

    expect(
      await fs.readFile(
        path.join(solution, '.monoceros', 'stack.json'),
        'utf8',
      ),
    ).toBe(stackBefore);
  });

  it('refuses to silently overwrite an existing feature with new options', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddFeature({
      ...baseModifyOpts,
      cwd: solution,
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      options: { version: 'latest' },
    });

    await expect(
      runAddFeature({
        ...baseModifyOpts,
        cwd: solution,
        ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
        options: { version: '24' },
      }),
    ).rejects.toThrow(/already configured with different options/);
  });

  it('rejects invalid feature refs (no shell metacharacters allowed)', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await expect(
      runAddFeature({
        ...baseModifyOpts,
        cwd: solution,
        ref: 'ghcr.io/foo; rm -rf /',
      }),
    ).rejects.toThrow(/Invalid devcontainer feature ref/);
  });

  it('rejects empty feature ref', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await expect(
      runAddFeature({
        ...baseModifyOpts,
        cwd: solution,
        ref: '',
      }),
    ).rejects.toThrow(/Missing feature ref/);
  });

  it('coexists with apt-packages and language features (sorted ref output)', async () => {
    const solution = await scaffold(cwd, {
      name: 'demo',
      languages: ['python'],
    });
    await runAddAptPackages({
      ...baseModifyOpts,
      cwd: solution,
      packages: ['jq'],
    });

    const result = await runAddFeature({
      ...baseModifyOpts,
      cwd: solution,
      ref: 'ghcr.io/devcontainers/features/github-cli:1',
      options: {},
    });
    expect(result.status).toBe('updated');

    const devcontainer = await readJson<{
      features?: Record<string, Record<string, unknown>>;
    }>(path.join(solution, '.devcontainer', 'devcontainer.json'));
    const refs = Object.keys(devcontainer.features ?? {});
    expect(refs).toContain('ghcr.io/devcontainers/features/python:1');
    expect(refs).toContain(
      'ghcr.io/devcontainers-contrib/features/apt-packages:1',
    );
    expect(refs).toContain('ghcr.io/devcontainers/features/github-cli:1');
  });
});

describe('runAddFromUrl', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'monoceros-add-from-url-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('appends the URL to stack.installUrls and post-create.sh', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    const result = await runAddFromUrl({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://example.com/install.sh',
    });
    expect(result.status).toBe('updated');

    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.installUrls).toEqual(['https://example.com/install.sh']);

    const postCreate = await fs.readFile(
      path.join(solution, '.devcontainer', 'post-create.sh'),
      'utf8',
    );
    expect(postCreate).toContain(
      'curl -fsSL "https://example.com/install.sh" | sh',
    );
    // Script must still be executable after the modify path writes it.
    const stat = await fs.stat(
      path.join(solution, '.devcontainer', 'post-create.sh'),
    );
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it('preserves insertion order across multiple URLs', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await runAddFromUrl({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://a.example/install',
    });
    await runAddFromUrl({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://b.example/install',
    });
    await runAddFromUrl({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://c.example/install',
    });

    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.installUrls).toEqual([
      'https://a.example/install',
      'https://b.example/install',
      'https://c.example/install',
    ]);

    const postCreate = await fs.readFile(
      path.join(solution, '.devcontainer', 'post-create.sh'),
      'utf8',
    );
    // Order in the script matches insertion order.
    const aIdx = postCreate.indexOf('a.example');
    const bIdx = postCreate.indexOf('b.example');
    const cIdx = postCreate.indexOf('c.example');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    expect(cIdx).toBeGreaterThan(bIdx);
  });

  it('is a no-op when the URL is already declared', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddFromUrl({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://example.com/install',
    });
    const stackBefore = await fs.readFile(
      path.join(solution, '.monoceros', 'stack.json'),
      'utf8',
    );

    const result = await runAddFromUrl({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://example.com/install',
    });
    expect(result.status).toBe('no-change');

    expect(
      await fs.readFile(
        path.join(solution, '.monoceros', 'stack.json'),
        'utf8',
      ),
    ).toBe(stackBefore);
  });

  it('rejects non-https URLs', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await expect(
      runAddFromUrl({
        ...baseModifyOpts,
        cwd: solution,
        url: 'http://example.com/install',
      }),
    ).rejects.toThrow(/Invalid install URL/);
  });

  it('rejects URLs with shell metacharacters', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await expect(
      runAddFromUrl({
        ...baseModifyOpts,
        cwd: solution,
        url: 'https://example.com/install$(whoami)',
      }),
    ).rejects.toThrow(/Invalid install URL/);
  });

  it('rejects empty URL', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await expect(
      runAddFromUrl({
        ...baseModifyOpts,
        cwd: solution,
        url: '',
      }),
    ).rejects.toThrow(/Missing URL/);
  });
});

describe('deriveRepoName', () => {
  it('strips .git from a https URL', () => {
    expect(deriveRepoName('https://github.com/foo/bar.git')).toBe('bar');
  });

  it('handles a https URL without .git', () => {
    expect(deriveRepoName('https://github.com/foo/bar')).toBe('bar');
  });

  it('handles a git@ SSH URL', () => {
    expect(deriveRepoName('git@github.com:foo/bar.git')).toBe('bar');
  });

  it('handles a ssh:// URL', () => {
    expect(deriveRepoName('ssh://git@github.com/foo/bar.git')).toBe('bar');
  });
});

describe('runAddRepo', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'monoceros-add-repo-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('persists the repo in stack.json and adds a clone block to post-create.sh', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    const result = await runAddRepo({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://github.com/foo/bar.git',
    });
    expect(result.status).toBe('updated');

    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.repos).toEqual([
      { url: 'https://github.com/foo/bar.git', name: 'bar' },
    ]);

    const postCreate = await fs.readFile(
      path.join(solution, '.devcontainer', 'post-create.sh'),
      'utf8',
    );
    expect(postCreate).toContain('if [ ! -d "projects/bar" ]; then');
    expect(postCreate).toContain(
      'git clone "https://github.com/foo/bar.git" "projects/bar"',
    );
  });

  it('adds the repo as a folder root in the code-workspace file', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddRepo({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://github.com/foo/bar.git',
    });
    const workspaceFile = path.join(solution, 'demo.code-workspace');
    const ws = await readJson<{
      folders: Array<{ path: string; name?: string }>;
    }>(workspaceFile);
    expect(ws.folders).toEqual([
      { path: '.' },
      { path: 'projects/bar', name: 'bar' },
    ]);
  });

  it('honors --name override and --branch flag', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddRepo({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://github.com/foo/bar.git',
      name: 'ui',
      branch: 'develop',
    });
    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.repos).toEqual([
      {
        url: 'https://github.com/foo/bar.git',
        name: 'ui',
        branch: 'develop',
      },
    ]);

    const postCreate = await fs.readFile(
      path.join(solution, '.devcontainer', 'post-create.sh'),
      'utf8',
    );
    expect(postCreate).toContain(
      'git clone --branch develop "https://github.com/foo/bar.git" "projects/ui"',
    );
  });

  it('is a no-op when the same repo is re-added', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddRepo({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://github.com/foo/bar.git',
    });
    const stackBefore = await fs.readFile(
      path.join(solution, '.monoceros', 'stack.json'),
      'utf8',
    );

    const result = await runAddRepo({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://github.com/foo/bar.git',
    });
    expect(result.status).toBe('no-change');

    expect(
      await fs.readFile(
        path.join(solution, '.monoceros', 'stack.json'),
        'utf8',
      ),
    ).toBe(stackBefore);
  });

  it('rejects two repos that collide on derived name', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddRepo({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://github.com/alice/bar.git',
    });

    await expect(
      runAddRepo({
        ...baseModifyOpts,
        cwd: solution,
        url: 'https://github.com/bob/bar.git',
      }),
    ).rejects.toThrow(/Duplicate repo name/);
  });

  it('rejects URLs with shell metacharacters', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await expect(
      runAddRepo({
        ...baseModifyOpts,
        cwd: solution,
        url: 'https://github.com/foo/bar.git; rm -rf /',
      }),
    ).rejects.toThrow(/Invalid repo URL/);
  });

  it('rejects an empty URL', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });

    await expect(
      runAddRepo({
        ...baseModifyOpts,
        cwd: solution,
        url: '',
      }),
    ).rejects.toThrow(/Missing repo URL/);
  });

  it('wires SSH-agent forwarding into devcontainer.json (image mode)', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddRepo({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://github.com/foo/bar.git',
    });
    const devcontainer = await readJson<{
      mounts?: string[];
      containerEnv?: Record<string, string>;
    }>(path.join(solution, '.devcontainer', 'devcontainer.json'));
    expect(
      devcontainer.mounts?.some((m) => m.includes('${localEnv:SSH_AUTH_SOCK}')),
    ).toBe(true);
    expect(devcontainer.containerEnv).toEqual({
      SSH_AUTH_SOCK: '/ssh-agent',
      GIT_SSH_COMMAND: 'ssh -o StrictHostKeyChecking=accept-new',
    });
  });

  it('wires SSH-agent forwarding into compose.yaml (compose mode)', async () => {
    const solution = await scaffold(cwd, {
      name: 'demo',
      services: ['postgres'],
    });
    await runAddRepo({
      ...baseModifyOpts,
      cwd: solution,
      url: 'https://github.com/foo/bar.git',
    });
    const compose = await fs.readFile(
      path.join(solution, '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    expect(compose).toContain('${SSH_AUTH_SOCK:-/dev/null}:/ssh-agent');
    expect(compose).toContain('SSH_AUTH_SOCK: /ssh-agent');
    expect(compose).toContain(
      'GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=accept-new"',
    );
    // devcontainer.json mirrors the env via containerEnv so devcontainer-
    // cli picks it up for the workspace service exec context.
    const devcontainer = await readJson<{
      containerEnv?: Record<string, string>;
      mounts?: string[];
    }>(path.join(solution, '.devcontainer', 'devcontainer.json'));
    expect(devcontainer.containerEnv?.SSH_AUTH_SOCK).toBe('/ssh-agent');
    // Compose-mode devcontainer.json doesn't use `mounts` — those live
    // in compose.yaml. The SSH mount must not leak into devcontainer.json
    // here.
    expect(devcontainer.mounts).toBeUndefined();
  });

  it('does NOT wire SSH-agent forwarding when no repos are configured', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    // Add something else (apt-package) but no repo.
    await runAddAptPackages({
      ...baseModifyOpts,
      cwd: solution,
      packages: ['jq'],
    });
    const devcontainer = await readJson<{
      mounts?: string[];
      containerEnv?: Record<string, string>;
    }>(path.join(solution, '.devcontainer', 'devcontainer.json'));
    expect(
      devcontainer.mounts?.some((m) => m.includes('${localEnv:SSH_AUTH_SOCK}')),
    ).toBe(false);
    expect(devcontainer.containerEnv).toBeUndefined();
  });
});

describe('remove-* on legacy stack.json solutions', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'monoceros-remove-legacy-'));
  });

  afterEach(async () => {
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('removeLanguage strips the language and drops the feature entry', async () => {
    const solution = await scaffold(cwd, {
      name: 'demo',
      languages: ['python'],
    });
    await runRemoveLanguage({
      ...baseModifyOpts,
      cwd: solution,
      language: 'python',
    });
    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.languages).toEqual([]);
    const devcontainer = await readJson<{ features?: Record<string, unknown> }>(
      path.join(solution, '.devcontainer', 'devcontainer.json'),
    );
    expect(devcontainer.features).toBeUndefined();
  });

  it('removeService demotes a single-service solution back to image-mode', async () => {
    const solution = await scaffold(cwd, {
      name: 'demo',
      services: ['postgres'],
    });
    await runRemoveService({
      ...baseModifyOpts,
      cwd: solution,
      service: 'postgres',
    });
    // compose.yaml is removed when the last service goes away.
    await expect(
      fs.access(path.join(solution, '.devcontainer', 'compose.yaml')),
    ).rejects.toThrow();
    const stack = await readJson<StackFile>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.services).toEqual([]);
  });

  it('removeAptPackages drops aptPackages when the last entry is removed', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddAptPackages({
      ...baseModifyOpts,
      cwd: solution,
      packages: ['jq', 'make'],
    });
    await runRemoveAptPackages({
      ...baseModifyOpts,
      cwd: solution,
      packages: ['jq', 'make'],
    });
    const stack = await readJson<{ aptPackages?: string[] }>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.aptPackages).toBeUndefined();
  });

  it('removeFeature drops a feature and prunes the features map', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddFeature({
      ...baseModifyOpts,
      cwd: solution,
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      options: { version: 'latest' },
    });
    await runRemoveFeature({
      ...baseModifyOpts,
      cwd: solution,
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
    });
    const stack = await readJson<{ features?: Record<string, unknown> }>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.features).toBeUndefined();
  });

  it('removeRepo by URL drops the entry and unmounts SSH-agent when no repos remain', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddRepo({
      ...baseModifyOpts,
      cwd: solution,
      url: 'git@github.com:foo/bar.git',
    });
    await runRemoveRepo({
      ...baseModifyOpts,
      cwd: solution,
      target: 'git@github.com:foo/bar.git',
    });
    const stack = await readJson<{ repos?: unknown[] }>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.repos).toBeUndefined();
    const devcontainer = await readJson<{
      mounts?: string[];
      containerEnv?: Record<string, string>;
    }>(path.join(solution, '.devcontainer', 'devcontainer.json'));
    expect(
      devcontainer.mounts?.some((m) => m.includes('${localEnv:SSH_AUTH_SOCK}')),
    ).toBe(false);
  });

  it('removeRepo by derived name works too', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    await runAddRepo({
      ...baseModifyOpts,
      cwd: solution,
      url: 'git@github.com:foo/bar.git',
    });
    expect(deriveRepoName('git@github.com:foo/bar.git')).toBe('bar');
    await runRemoveRepo({
      ...baseModifyOpts,
      cwd: solution,
      target: 'bar',
    });
    const stack = await readJson<{ repos?: unknown[] }>(
      path.join(solution, '.monoceros', 'stack.json'),
    );
    expect(stack.repos).toBeUndefined();
  });

  it('removeLanguage is a no-op when the language is not present', async () => {
    const solution = await scaffold(cwd, { name: 'demo' });
    const result = await runRemoveLanguage({
      ...baseModifyOpts,
      cwd: solution,
      language: 'python',
    });
    expect(result.status).toBe('no-change');
  });
});
