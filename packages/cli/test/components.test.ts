import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadComponentCatalog,
  mergeComponents,
  resolveComponents,
} from '../src/init/components.js';

describe('component catalog reader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'monoceros-components-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeComponent(rel: string, body: string): Promise<void> {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
  }

  it('loads a flat language component', async () => {
    await writeComponent(
      'node.yml',
      [
        'displayName: Node 22',
        'description: Node 22 runtime.',
        'category: language',
        'contributes:',
        '  languages: [node]',
        '',
      ].join('\n'),
    );
    const catalog = await loadComponentCatalog(dir);
    const c = catalog.get('node');
    expect(c).toBeDefined();
    expect(c?.file.category).toBe('language');
    expect(c?.file.contributes.languages).toEqual(['node']);
  });

  it('loads a sub-component using slash-form name', async () => {
    await writeComponent(
      'atlassian/twg.yml',
      [
        'displayName: TWG',
        'description: Just twg.',
        'category: feature',
        'contributes:',
        '  features:',
        '    - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1',
        '      options:',
        '        twg: true',
        '        rovodev: false',
        '',
      ].join('\n'),
    );
    const catalog = await loadComponentCatalog(dir);
    expect(catalog.has('atlassian/twg')).toBe(true);
    expect(catalog.get('atlassian/twg')?.file.contributes.features).toEqual([
      {
        ref: 'ghcr.io/getmonoceros/monoceros-features/atlassian:1',
        options: { twg: true, rovodev: false },
      },
    ]);
  });

  it('skips README and non-yml files in the catalog dir', async () => {
    await writeComponent(
      'node.yml',
      [
        'displayName: Node',
        'description: Node.',
        'category: language',
        'contributes:',
        '  languages: [node]',
        '',
      ].join('\n'),
    );
    await writeFile(path.join(dir, 'README.md'), '# not a component\n');
    await writeFile(path.join(dir, 'notes.txt'), 'random');
    const catalog = await loadComponentCatalog(dir);
    expect([...catalog.keys()]).toEqual(['node']);
  });

  it('returns an empty catalog when the directory does not exist', async () => {
    const catalog = await loadComponentCatalog(
      path.join(dir, 'does-not-exist'),
    );
    expect(catalog.size).toBe(0);
  });

  it('rejects a component whose category mismatches the contributions', async () => {
    await writeComponent(
      'broken.yml',
      [
        'displayName: Broken',
        'description: Wrong category.',
        'category: language',
        'contributes:',
        '  features:',
        '    - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        '',
      ].join('\n'),
    );
    await expect(loadComponentCatalog(dir)).rejects.toThrow(
      /category 'language' requires contributes\.languages/,
    );
  });

  it('rejects a component that contributes to multiple sections at once', async () => {
    await writeComponent(
      'both.yml',
      [
        'displayName: Both',
        'description: Too many.',
        'category: language',
        'contributes:',
        '  languages: [node]',
        '  services: [postgres]',
        '',
      ].join('\n'),
    );
    await expect(loadComponentCatalog(dir)).rejects.toThrow(/exactly one of/);
  });

  it('rejects a component with an invalid feature ref', async () => {
    await writeComponent(
      'bad-ref.yml',
      [
        'displayName: Bad',
        'description: Bad ref.',
        'category: feature',
        'contributes:',
        '  features:',
        '    - ref: not-a-real-ref',
        '',
      ].join('\n'),
    );
    await expect(loadComponentCatalog(dir)).rejects.toThrow(/ref/);
  });
});

describe('mergeComponents', () => {
  function component(name: string, file: object) {
    return { name, sourcePath: `/fake/${name}.yml`, file: file as never };
  }

  it('dedupes languages and services across components', () => {
    const merged = mergeComponents([
      component('node', {
        displayName: 'Node',
        description: 'Node.',
        category: 'language',
        contributes: { languages: ['node'] },
      }),
      component('node-also', {
        displayName: 'Node again',
        description: 'Twice for some reason.',
        category: 'language',
        contributes: { languages: ['node'] },
      }),
      component('postgres', {
        displayName: 'Postgres',
        description: 'Postgres.',
        category: 'service',
        contributes: { services: ['postgres'] },
      }),
    ]);
    expect(merged.languages).toEqual(['node']);
    expect(merged.services).toEqual(['postgres']);
  });

  it('merges multiple feature contributions with the same ref using OR on booleans', () => {
    const merged = mergeComponents([
      component('atlassian/rovodev', {
        displayName: 'Rovo',
        description: 'rovodev only.',
        category: 'feature',
        contributes: {
          features: [
            {
              ref: 'ghcr.io/getmonoceros/monoceros-features/atlassian:1',
              options: { rovodev: true, twg: false },
            },
          ],
        },
      }),
      component('atlassian/twg', {
        displayName: 'TWG',
        description: 'twg only.',
        category: 'feature',
        contributes: {
          features: [
            {
              ref: 'ghcr.io/getmonoceros/monoceros-features/atlassian:1',
              options: { rovodev: false, twg: true },
            },
          ],
        },
      }),
    ]);
    expect(merged.features).toEqual([
      {
        ref: 'ghcr.io/getmonoceros/monoceros-features/atlassian:1',
        options: { rovodev: true, twg: true },
      },
    ]);
  });

  it('keeps the first inserted feature options and adds new ones on subsequent merges', () => {
    const merged = mergeComponents([
      component('claude', {
        displayName: 'Claude',
        description: '.',
        category: 'feature',
        contributes: {
          features: [
            { ref: 'ghcr.io/getmonoceros/monoceros-features/claude-code:1' },
          ],
        },
      }),
      component('claude-again', {
        displayName: 'Claude again',
        description: '.',
        category: 'feature',
        contributes: {
          features: [
            {
              ref: 'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
              options: { apiKey: 'sk-…' },
            },
          ],
        },
      }),
    ]);
    expect(merged.features).toEqual([
      {
        ref: 'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        options: { apiKey: 'sk-…' },
      },
    ]);
  });
});

describe('resolveComponents', () => {
  function fakeCatalog(names: string[]): Map<string, never> {
    return new Map(
      names.map((n) => [
        n,
        { name: n, sourcePath: `/fake/${n}.yml`, file: {} } as never,
      ]),
    );
  }

  it('returns components in the requested order', () => {
    const catalog = fakeCatalog(['node', 'postgres', 'claude']);
    const resolved = resolveComponents(catalog, ['claude', 'node']);
    expect(resolved.map((r) => r.component.name)).toEqual(['claude', 'node']);
    expect(resolved.every((r) => r.version === undefined)).toBe(true);
  });

  it('errors with the full list of unknown names plus what is available', () => {
    const catalog = fakeCatalog(['node', 'postgres']);
    expect(() => resolveComponents(catalog, ['node', 'rust', 'mongo'])).toThrow(
      /Unknown components?: rust, mongo[\s\S]*node, postgres/,
    );
  });

  it('attaches the :version suffix when the component is a language', () => {
    const catalog = new Map([
      [
        'node',
        {
          name: 'node',
          sourcePath: '/fake/node.yml',
          file: { category: 'language', contributes: { languages: ['node'] } },
        } as never,
      ],
    ]);
    const resolved = resolveComponents(catalog, ['node:20']);
    expect(resolved).toEqual([
      { component: catalog.get('node'), version: '20' },
    ]);
  });

  it('rejects a :version suffix on a non-language component', () => {
    const catalog = new Map([
      [
        'postgres',
        {
          name: 'postgres',
          sourcePath: '/fake/postgres.yml',
          file: {
            category: 'service',
            contributes: { services: ['postgres'] },
          },
        } as never,
      ],
    ]);
    expect(() => resolveComponents(catalog, ['postgres:16'])).toThrow(
      /Component 'postgres' is a service.*:16.*no meaning/,
    );
  });
});
