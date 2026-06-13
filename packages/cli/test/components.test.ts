import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildComponentCatalog,
  mergeComponents,
  resolveComponents,
} from '../src/init/components.js';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { writeDescriptor } from './helpers/fake-workbench.js';

// Descriptor parsing + validation is covered in catalog-descriptor.test.ts;
// here we test the projection from descriptors into the legacy Component shape
// that init's resolve/merge consumes (incl. preset expansion + selector names).
describe('buildComponentCatalog (descriptor projection)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-components-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function build() {
    return buildComponentCatalog(
      await loadDescriptorCatalog(path.join(root, 'components')),
    );
  }

  it('projects a language descriptor to a languages contribution', async () => {
    await writeDescriptor(
      root,
      'languages',
      'node',
      [
        'id: node',
        'category: language',
        'displayName: Node.js',
        'description: Node runtime.',
        'language:',
        '  feature: ghcr.io/devcontainers/features/node:1',
        '',
      ].join('\n'),
    );
    const catalog = await build();
    const c = catalog.get('node');
    expect(c?.file.category).toBe('language');
    expect(c?.file.contributes.languages).toEqual(['node']);
  });

  it('exposes a feature and its presets with reconstructed ref + merged options', async () => {
    await writeDescriptor(
      root,
      'features',
      'atlassian',
      [
        'id: atlassian',
        'category: feature',
        'displayName: Atlassian',
        'description: Both tools.',
        'options:',
        '  rovodev: { type: boolean, default: true, surface: yml }',
        '  twg: { type: boolean, default: true, surface: yml }',
        'feature:',
        '  version: 1.0.0',
        'presets:',
        '  twg: { rovodev: false, twg: true }',
        '',
      ].join('\n'),
    );
    const catalog = await build();
    expect(catalog.get('atlassian')?.file.contributes.features).toEqual([
      {
        ref: 'ghcr.io/getmonoceros/monoceros-features/atlassian:1',
        options: { rovodev: true, twg: true },
      },
    ]);
    expect(catalog.get('atlassian/twg')?.file.contributes.features).toEqual([
      {
        ref: 'ghcr.io/getmonoceros/monoceros-features/atlassian:1',
        options: { rovodev: false, twg: true },
      },
    ]);
  });

  it('keys a feature by its selector name, not the manifest id', async () => {
    await writeDescriptor(
      root,
      'features',
      'claude-code',
      [
        'id: claude-code',
        'name: claude',
        'category: feature',
        'displayName: Claude Code',
        'description: Claude Code CLI.',
        'feature:',
        '  version: 1.2.0',
        '',
      ].join('\n'),
    );
    const catalog = await build();
    expect(catalog.has('claude')).toBe(true);
    expect(catalog.has('claude-code')).toBe(false);
    expect(catalog.get('claude')?.file.contributes.features?.[0]?.ref).toBe(
      'ghcr.io/getmonoceros/monoceros-features/claude-code:1',
    );
  });

  it('returns an empty catalog when the directory does not exist', async () => {
    const catalog = buildComponentCatalog(
      await loadDescriptorCatalog(path.join(root, 'does-not-exist')),
    );
    expect(catalog.size).toBe(0);
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
