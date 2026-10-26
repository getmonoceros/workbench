import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import type { CatalogComponent } from '../src/catalog/load.js';
import {
  projectWorkbenchTemplate,
  readWorkbenchTemplates,
} from '../src/init/templates.js';
import type { TemplateFile } from '../src/init/templates.js';

// test/ -> packages/cli -> packages -> <checkout root>
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const componentsRoot = path.join(repoRoot, 'components');

function template(text: string[], local = true): TemplateFile {
  return {
    name: 'standard',
    file: '/home/templates/workbenches/standard.yml',
    text: text.join('\n'),
    local,
  };
}

const HEADER = [
  'schemaVersion: 1',
  'name: __MONOCEROS_NAME__',
  'runtimeVersion: __MONOCEROS_RUNTIME_VERSION__',
];

/**
 * What `list-components --json` says a workbench template brings. A consumer
 * outside the machine (the discovery tech frame) checks requirements against
 * it and proposes only the `--with-*` flags still missing.
 */
describe('projectWorkbenchTemplate', () => {
  let catalog: Map<string, CatalogComponent>;
  beforeEach(async () => {
    catalog = await loadDescriptorCatalog(componentsRoot);
  });

  it('lists the contents with features by selector name', () => {
    const out = projectWorkbenchTemplate(
      template([
        '# Node and Postgres with Claude Code and the Atlassian CLIs.',
        ...HEADER,
        'languages:',
        '  - node:24',
        '  - java:',
        '      version: 21',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        '    plugins:',
        '      - url: https://github.com/getmonoceros/monoceros-discovery.git',
        '        enable: [discovery-atlassian]',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1',
        '    options:',
        '      twg: true',
        '      rovodev: false',
        'services:',
        '  - name: postgres',
        '    image: postgres:17',
        '  - name: analytics',
        '    ref: postgres@1',
        '    image: postgres:18',
        'mcpServers:',
        '  - name: context7',
      ]),
      catalog,
    );
    expect(out).toEqual({
      name: 'standard',
      local: true,
      source: 'personal',
      description: 'Node and Postgres with Claude Code and the Atlassian CLIs.',
      languages: ['node:24', 'java:21'],
      services: ['postgres', 'postgres@1'],
      features: [
        {
          name: 'claude',
          plugins: [
            {
              url: 'https://github.com/getmonoceros/monoceros-discovery.git',
              enable: ['discovery-atlassian'],
            },
          ],
        },
        { name: 'atlassian', options: { twg: true, rovodev: false } },
      ],
      mcpServers: ['context7'],
    });
  });

  it('leaves out an option whose value is a ${VAR} credential', () => {
    const out = projectWorkbenchTemplate(
      template([
        ...HEADER,
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1',
        '    options:',
        '      twg: true',
        '      apiToken: ${ATLASSIAN_API_TOKEN}',
        '      instance: https://${ATLASSIAN_SITE}.atlassian.net',
      ]),
      catalog,
    );
    expect(out.features).toEqual([
      { name: 'atlassian', options: { twg: true } },
    ]);
  });

  it('keeps a ref the catalog does not know as its ref', () => {
    const out = projectWorkbenchTemplate(
      template([
        ...HEADER,
        'features:',
        '  - ref: ghcr.io/devcontainers/features/terraform:1',
      ]),
      catalog,
    );
    expect(out.features).toEqual([
      { name: 'ghcr.io/devcontainers/features/terraform:1' },
    ]);
  });

  it('skips the header paragraph and drops URL lines', () => {
    const out = projectWorkbenchTemplate(
      template([
        '# The workbench `__MONOCEROS_NAME__`, from the `standard` template.',
        '# This file is the source of truth.',
        '# https://getmonoceros.build/docs/concepts/configuration/',
        '#',
        '# What is in here: Node and Postgres,',
        '# plus Claude Code.',
        '# https://getmonoceros.build/docs/guides/templates/',
        '',
        ...HEADER,
      ]),
      catalog,
    );
    expect(out.description).toBe(
      'What is in here: Node and Postgres, plus Claude Code.',
    );
  });

  /**
   * The documented way to a template: copy a working config and put the two
   * placeholders back into `name:` and `runtimeVersion:`. The header comment
   * keeps the real name, and must not become the description.
   */
  it('skips the header of a copied config, which keeps the real name', () => {
    const fromTemplate = projectWorkbenchTemplate(
      template([
        '# The workbench `ssp-cs`, from the `discovery-atlassian` template.',
        '# This file is the source of truth; the container is built from it.',
        '#',
        '# What is in here: Claude Code with the discovery skills.',
        '',
        ...HEADER,
      ]),
      catalog,
    );
    expect(fromTemplate.description).toBe(
      'What is in here: Claude Code with the discovery skills.',
    );

    const plain = projectWorkbenchTemplate(
      template([
        '# The workbench `proj-one`. This file is the source of truth; the container',
        '# is built from it. Change it here or with `monoceros add-*`, then run',
        '# `monoceros apply proj-one`.',
        '# https://getmonoceros.build/docs/concepts/configuration/',
        '',
        ...HEADER,
      ]),
      catalog,
    );
    expect(plain).not.toHaveProperty('description');
  });

  it('gives a template without a comment no description and a shipped one no local marker', () => {
    const out = projectWorkbenchTemplate(template(HEADER, false), catalog);
    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('local');
    expect(out).not.toHaveProperty('source');
  });

  it("marks a template the team repository has committed as the team's", () => {
    const t = template(HEADER);
    const out = projectWorkbenchTemplate(t, catalog, {
      committed: new Set([t.file]),
    });
    expect(out).toMatchObject({ local: true, source: 'team' });
  });

  it('fails on a broken template and names its file', () => {
    expect(() =>
      projectWorkbenchTemplate(
        template([...HEADER, 'services:', '  - name: Bad Name']),
        catalog,
      ),
    ).toThrow(
      /Invalid workbench template \/home\/templates\/workbenches\/standard\.yml/,
    );
  });

  it('describes every shipped template', async () => {
    const shipped = await readWorkbenchTemplates([
      {
        dir: path.join(repoRoot, 'packages', 'cli', 'templates', 'workbenches'),
        local: false,
      },
    ]);
    expect(shipped.length).toBeGreaterThan(0);
    for (const t of shipped) {
      const out = projectWorkbenchTemplate(t, catalog);
      expect(out.description, t.name).toMatch(/^What is in here:/);
    }
  });
});

describe('readWorkbenchTemplates', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'monoceros-tpl-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads each name once, the builder's file first, sorted", async () => {
    const user = path.join(dir, 'user');
    const shipped = path.join(dir, 'shipped');
    await mkdir(user, { recursive: true });
    await mkdir(shipped, { recursive: true });
    await writeFile(path.join(user, 'web-app.yml'), 'own', 'utf8');
    await writeFile(path.join(shipped, 'web-app.yml'), 'shipped', 'utf8');
    await writeFile(path.join(shipped, 'agent.yml'), 'shipped', 'utf8');
    await writeFile(path.join(user, 'README.md'), 'not a template', 'utf8');

    const out = await readWorkbenchTemplates([
      { dir: user, local: true },
      { dir: shipped, local: false },
      { dir: path.join(dir, 'missing'), local: true },
    ]);
    expect(out.map((t) => [t.name, t.text, t.local])).toEqual([
      ['agent', 'shipped', false],
      ['web-app', 'own', true],
    ]);
  });
});
