import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/init/index.js';
import { parseConfig } from '../src/config/index.js';

const silentLogger = {
  success: () => {},
  info: () => {},
};

describe('runInit', () => {
  let root: string;

  beforeEach(async () => {
    // Build a tmp "workbench root" with the shipped templates copied in.
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-init-'));
    const yml = path.join(root, 'templates', 'yml');
    await mkdir(yml, { recursive: true });
    await writeFile(
      path.join(yml, 'bare.yml'),
      [
        '# Bare template — minimal yml.',
        '# This comment must survive the copy.',
        '',
        'schemaVersion: 1',
        'name: bare',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(yml, 'python.yml'),
      [
        '# Python template.',
        'schemaVersion: 1',
        'name: python',
        'languages:',
        '  - python',
        '',
      ].join('\n'),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies a template, rewrites name, and lands at .local/container-configs/<name>.yml', async () => {
    const result = await runInit({
      template: 'bare',
      name: 'sandbox',
      workbenchRoot: root,
      monocerosHome: path.join(root, '.local'),
      logger: silentLogger,
    });

    const expected = path.join(
      root,
      '.local',
      'container-configs',
      'sandbox.yml',
    );
    expect(result.configPath).toBe(expected);

    const text = await readFile(expected, 'utf8');
    expect(text).toContain('name: sandbox');
    expect(text).not.toContain('name: bare');
  });

  it('preserves the template comment block on copy', async () => {
    await runInit({
      template: 'bare',
      name: 'sandbox',
      workbenchRoot: root,
      monocerosHome: path.join(root, '.local'),
      logger: silentLogger,
    });
    const text = await readFile(
      path.join(root, '.local', 'container-configs', 'sandbox.yml'),
      'utf8',
    );
    expect(text).toContain('# Bare template — minimal yml.');
    expect(text).toContain('# This comment must survive the copy.');
  });

  it('produces a config that validates against the schema', async () => {
    await runInit({
      template: 'python',
      name: 'my-py',
      workbenchRoot: root,
      monocerosHome: path.join(root, '.local'),
      logger: silentLogger,
    });
    const text = await readFile(
      path.join(root, '.local', 'container-configs', 'my-py.yml'),
      'utf8',
    );
    const parsed = parseConfig(text);
    expect(parsed.config.name).toBe('my-py');
    expect(parsed.config.languages).toEqual(['python']);
  });

  it('errors when the template does not exist and lists alternatives', async () => {
    await expect(
      runInit({
        template: 'rust',
        name: 'demo',
        workbenchRoot: root,
        monocerosHome: path.join(root, '.local'),
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Unknown template: rust.*bare.*python/s);
  });

  it('errors when the target config already exists', async () => {
    await runInit({
      template: 'bare',
      name: 'sandbox',
      workbenchRoot: root,
      monocerosHome: path.join(root, '.local'),
      logger: silentLogger,
    });
    await expect(
      runInit({
        template: 'bare',
        name: 'sandbox',
        workbenchRoot: root,
        monocerosHome: path.join(root, '.local'),
        logger: silentLogger,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects an invalid config name without writing anything', async () => {
    await expect(
      runInit({
        template: 'bare',
        name: 'has space',
        workbenchRoot: root,
        monocerosHome: path.join(root, '.local'),
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Invalid config name/);
  });

  it('rejects an invalid template name', async () => {
    await expect(
      runInit({
        template: 'has space',
        name: 'sandbox',
        workbenchRoot: root,
        monocerosHome: path.join(root, '.local'),
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Invalid template name/);
  });

  it('surfaces schema errors when a shipped template is broken', async () => {
    await writeFile(
      path.join(root, 'templates', 'yml', 'broken.yml'),
      'schemaVersion: 99\nname: broken\n',
    );
    await expect(
      runInit({
        template: 'broken',
        name: 'demo',
        workbenchRoot: root,
        monocerosHome: path.join(root, '.local'),
        logger: silentLogger,
      }),
    ).rejects.toThrow(/schemaVersion/);
  });
});
