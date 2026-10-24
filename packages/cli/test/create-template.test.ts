import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runCreateTemplate,
  toTemplate,
  withDescription,
} from '../src/init/create-template.js';
import { runInit } from '../src/init/index.js';
import { renderWorkbenchTemplate } from '../src/init/templates.js';

// `monoceros create-template <containername> <template>` (#142).

const HEADER = [
  '# The workbench `shop`. This file is the source of truth; the container',
  '# is built from it. Change it here or with `monoceros add-*`, then run',
  '# `monoceros apply shop`.',
  '# https://getmonoceros.build/docs/concepts/configuration/',
];

describe('toTemplate', () => {
  it('replaces the name where it stands as a word, in name: and the comments', () => {
    const out = toTemplate(
      [
        ...HEADER,
        '',
        'schemaVersion: 1',
        'name: shop',
        'runtimeVersion: 1.11.0',
        '# values resolve from shop.env at apply time',
        '# reachable as shop-3000.localhost and shop.localhost',
        'repos:',
        '  - url: https://github.com/acme/shop-web.git',
        '# see https://github.com/acme/shop for the code',
        '# shopping lists and workshop notes stay as they are',
      ].join('\n'),
      'shop',
    );
    expect(out.split('\n')).toEqual([
      '# The workbench `__MONOCEROS_NAME__`. This file is the source of truth; the container',
      '# is built from it. Change it here or with `monoceros add-*`, then run',
      '# `monoceros apply __MONOCEROS_NAME__`.',
      '# https://getmonoceros.build/docs/concepts/configuration/',
      '',
      'schemaVersion: 1',
      'name: __MONOCEROS_NAME__',
      'runtimeVersion: __MONOCEROS_RUNTIME_VERSION__',
      '# values resolve from __MONOCEROS_NAME__.env at apply time',
      '# reachable as __MONOCEROS_NAME__-3000.localhost and __MONOCEROS_NAME__.localhost',
      'repos:',
      '  - url: https://github.com/acme/shop-web.git',
      '# see https://github.com/acme/shop for the code',
      '# shopping lists and workshop notes stay as they are',
    ]);
  });

  it('treats a name with a dot as the literal name', () => {
    expect(toTemplate('name: a.b\n# monoceros apply a.b\n# axb', 'a.b')).toBe(
      'name: __MONOCEROS_NAME__\n# monoceros apply __MONOCEROS_NAME__\n# axb',
    );
  });
});

describe('withDescription', () => {
  const body = ['', 'schemaVersion: 1'];

  it('puts the description as the paragraph after the header', () => {
    expect(
      withDescription([...HEADER, ...body].join('\n'), 'Node with Postgres.'),
    ).toBe([...HEADER, '#', '# Node with Postgres.', ...body].join('\n'));
  });

  it('replaces the description a template-made workbench already carries', () => {
    const text = [
      ...HEADER,
      '#',
      '# What is in here: the old template.',
      '# https://getmonoceros.build/docs/guides/templates/',
      ...body,
    ].join('\n');
    expect(withDescription(text, 'Node with Postgres.')).toBe(
      [...HEADER, '#', '# Node with Postgres.', ...body].join('\n'),
    );
  });

  it('puts it on top of a yml without a leading comment', () => {
    expect(withDescription('schemaVersion: 1', 'Node.')).toBe(
      '# Node.\n\nschemaVersion: 1',
    );
  });

  it('wraps a long description into comment lines', () => {
    const out = withDescription(HEADER.join('\n'), 'word '.repeat(40).trim());
    for (const line of out.split('\n'))
      expect(line.length).toBeLessThanOrEqual(90);
  });
});

describe('runCreateTemplate', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'monoceros-create-template-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const silent = { info: () => {}, success: () => {}, warn: () => {} };

  it('renders back to the original yml under the original name', async () => {
    const { configPath } = await runInit({
      name: 'shop',
      languages: ['node'],
      services: ['postgres', 'mailpit'],
      monocerosHome: home,
      yes: true,
      logger: silent,
    });
    const original = await readFile(configPath, 'utf8');
    const result = await runCreateTemplate({
      name: 'shop',
      template: 'webshop',
      monocerosHome: home,
    });
    expect(result.description).toBeUndefined();
    const template = await readFile(result.file, 'utf8');
    expect(template).not.toMatch(/\bshop\b/);
    expect(
      await renderWorkbenchTemplate('webshop', 'shop', {
        userDir: path.join(home, 'templates', 'workbenches'),
        bundledDir: path.join(home, 'none'),
      }),
    ).toBe(original);
  });

  it('copies the yml only, never the env values', async () => {
    await runInit({
      name: 'shop',
      services: ['postgres'],
      monocerosHome: home,
      yes: true,
      logger: silent,
    });
    const env = path.join(home, 'container-configs', 'shop.env');
    await writeFile(env, 'POSTGRES_PASSWORD=very-secret\n');
    const result = await runCreateTemplate({
      name: 'shop',
      template: 'webshop',
      description: 'Postgres for the shop.',
      monocerosHome: home,
    });
    const template = await readFile(result.file, 'utf8');
    expect(template).not.toContain('very-secret');
    expect(template).toContain('${POSTGRES_PASSWORD}');
    expect(result.description).toBe('Postgres for the shop.');
  });

  it('refuses to overwrite a template, an unknown workbench and a bad name', async () => {
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    await writeFile(
      path.join(home, 'container-configs', 'shop.yml'),
      'schemaVersion: 1\nname: shop\n',
    );
    await mkdir(path.join(home, 'templates', 'workbenches'), {
      recursive: true,
    });
    await writeFile(
      path.join(home, 'templates', 'workbenches', 'webshop.yml'),
      'x',
    );
    await expect(
      runCreateTemplate({
        name: 'shop',
        template: 'webshop',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/webshop\.yml already exists/);
    await expect(
      runCreateTemplate({ name: 'nope', template: 'x', monocerosHome: home }),
    ).rejects.toThrow(/There is no workbench 'nope'/);
    await expect(
      runCreateTemplate({
        name: 'shop',
        template: '../x',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Invalid template name/);
  });
});
