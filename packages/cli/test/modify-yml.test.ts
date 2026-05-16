import { promises as fs, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runAddAptPackages,
  runAddFeature,
  runAddFromUrl,
  runAddLanguage,
  runAddRepo,
  runAddService,
  runRemoveAptPackages,
  runRemoveFeature,
  runRemoveFromUrl,
  runRemoveLanguage,
  runRemoveRepo,
  runRemoveService,
} from '../src/modify/index.js';

const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
};

const baseOpts = {
  yes: true,
  logger: silentLogger,
  confirm: async () => true,
  output: () => {},
};

describe('add-*/remove-* against the yml', () => {
  let home: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'monoceros-modify-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
  });

  afterEach(() => {
    if (home && existsSync(home))
      rmSync(home, { recursive: true, force: true });
  });

  async function writeYml(name: string, yml: string): Promise<void> {
    await writeFile(path.join(home, 'container-configs', `${name}.yml`), yml);
  }
  async function ymlOf(name: string): Promise<string> {
    return fs.readFile(
      path.join(home, 'container-configs', `${name}.yml`),
      'utf8',
    );
  }

  // ─── add-* ────────────────────────────────────────────────────────

  it('runAddLanguage appends and preserves the comment block', async () => {
    await writeYml('demo', '# my notes\nschemaVersion: 1\nname: demo\n');
    const result = await runAddLanguage({
      ...baseOpts,
      name: 'demo',
      language: 'python',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('# my notes');
    expect(yml).toContain('languages:');
    expect(yml).toContain('- python');
  });

  it('runAddService is a no-op when the service is already present', async () => {
    await writeYml(
      'demo',
      ['schemaVersion: 1', 'name: demo', 'services:', '  - postgres', ''].join(
        '\n',
      ),
    );
    const result = await runAddService({
      ...baseOpts,
      name: 'demo',
      service: 'postgres',
      monocerosHome: home,
    });
    expect(result.status).toBe('no-change');
  });

  it('runAddAptPackages appends only the new packages and preserves inline comments', async () => {
    await writeYml(
      'demo',
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
      name: 'demo',
      packages: ['jq', 'curl'],
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('# build essential');
    expect(yml).toContain('- curl');
    expect(yml.match(/- jq\b/g)).toHaveLength(1);
  });

  it('runAddFromUrl appends to installUrls', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFromUrl({
      ...baseOpts,
      name: 'demo',
      url: 'https://example.com/install',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('installUrls:');
    expect(yml).toContain('- https://example.com/install');
  });

  it('runAddFeature writes a structured entry with options', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      options: { version: 'latest' },
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain(
      '- ref: ghcr.io/devcontainers/features/docker-in-docker:2',
    );
    expect(yml).toContain('options:');
    expect(yml).toContain('version: latest');
  });

  it('runAddFeature errors when re-adding with different options', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      options: { version: 'latest' },
      monocerosHome: home,
    });
    await expect(
      runAddFeature({
        ...baseOpts,
        name: 'demo',
        ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
        options: { version: '20.10' },
        monocerosHome: home,
      }),
    ).rejects.toThrow(/different options/);
  });

  it('runAddRepo appends a repo entry, omitting redundant name', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'git@github.com:foo/bar.git',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('repos:');
    expect(yml).toContain('- url: git@github.com:foo/bar.git');
    expect(yml).not.toMatch(/name: bar\b/);
  });

  it('runAddRepo persists a non-default name via repoName', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      repoName: 'ui',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('name: ui');
  });

  it('aborts cleanly when the user declines the prompt', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runAddLanguage({
      ...baseOpts,
      yes: false,
      confirm: async () => false,
      name: 'demo',
      language: 'python',
      monocerosHome: home,
    });
    expect(result.status).toBe('aborted');
    const yml = await ymlOf('demo');
    expect(yml).not.toContain('python');
  });

  it('errors when the named config does not exist', async () => {
    await expect(
      runAddLanguage({
        ...baseOpts,
        name: 'nope',
        language: 'python',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/No such config.*nope\.yml/);
  });

  it('rejects an invalid container name without touching disk', async () => {
    await expect(
      runAddLanguage({
        ...baseOpts,
        name: 'has space',
        language: 'python',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Invalid container name/);
  });

  // ─── remove-* ─────────────────────────────────────────────────────

  it('runRemoveLanguage removes the entry and drops the empty array', async () => {
    await writeYml(
      'demo',
      [
        '# my notes',
        'schemaVersion: 1',
        'name: demo',
        'languages:',
        '  - python',
        '',
      ].join('\n'),
    );
    const result = await runRemoveLanguage({
      ...baseOpts,
      name: 'demo',
      language: 'python',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('# my notes');
    expect(yml).not.toContain('python');
    expect(yml).not.toContain('languages:');
  });

  it('runRemoveService removes one service while leaving others intact', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - postgres',
        '  - redis',
        '',
      ].join('\n'),
    );
    await runRemoveService({
      ...baseOpts,
      name: 'demo',
      service: 'postgres',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('- redis');
    expect(yml).not.toContain('postgres');
  });

  it('runRemoveLanguage is a no-op when the entry is missing', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runRemoveLanguage({
      ...baseOpts,
      name: 'demo',
      language: 'python',
      monocerosHome: home,
    });
    expect(result.status).toBe('no-change');
  });

  it('runRemoveAptPackages strips multiple, preserving comments on survivors', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'aptPackages:',
        '  - make',
        '  - jq # JSON in shell',
        '  - curl',
        '',
      ].join('\n'),
    );
    await runRemoveAptPackages({
      ...baseOpts,
      name: 'demo',
      packages: ['make', 'curl'],
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('- jq # JSON in shell');
    expect(yml).not.toContain('- make');
    expect(yml).not.toContain('- curl');
  });

  it('runRemoveFeature drops a feature entry by ref', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'features:',
        '  - ref: ghcr.io/devcontainers/features/docker-in-docker:2',
        '    options:',
        '      version: latest',
        '',
      ].join('\n'),
    );
    await runRemoveFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).not.toContain('docker-in-docker');
    expect(yml).not.toContain('features:');
  });

  it('runRemoveFromUrl drops an install URL', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'installUrls:',
        '  - https://example.com/a',
        '  - https://example.com/b',
        '',
      ].join('\n'),
    );
    await runRemoveFromUrl({
      ...baseOpts,
      name: 'demo',
      url: 'https://example.com/a',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('- https://example.com/b');
    expect(yml).not.toContain('- https://example.com/a');
  });

  it('runRemoveRepo matches by url', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'repos:',
        '  - url: git@github.com:foo/bar.git',
        '  - url: git@github.com:foo/baz.git',
        '',
      ].join('\n'),
    );
    await runRemoveRepo({
      ...baseOpts,
      name: 'demo',
      target: 'git@github.com:foo/bar.git',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('baz.git');
    expect(yml).not.toContain('bar.git');
  });

  it('runRemoveRepo matches by derived (URL-default) name', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'repos:',
        '  - url: git@github.com:foo/bar.git',
        '',
      ].join('\n'),
    );
    await runRemoveRepo({
      ...baseOpts,
      name: 'demo',
      target: 'bar',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).not.toContain('repos:');
  });

  it('runRemoveRepo matches by explicit name', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'repos:',
        '  - url: https://github.com/foo/bar.git',
        '    name: ui',
        '',
      ].join('\n'),
    );
    await runRemoveRepo({
      ...baseOpts,
      name: 'demo',
      target: 'ui',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).not.toContain('repos:');
  });
});
