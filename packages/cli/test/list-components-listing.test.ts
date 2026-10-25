import { describe, expect, it } from 'vitest';
import {
  renderListing,
  templateContents,
} from '../src/commands/list-components.js';
import type { ListingSection } from '../src/commands/list-components.js';
import { colorsFor } from '../src/util/format.js';

// A palette that never colours, so the TTY layout can be compared as text.
const plain = colorsFor({ isTTY: false } as NodeJS.WriteStream);

const sections: ListingSection[] = [
  {
    key: 'service',
    label: 'Services',
    items: [
      { name: 'redis', label: 'Redis', desc: 'In-memory key-value store.' },
      {
        name: 'meilisearch',
        label: 'Meilisearch (local)',
        desc: 'Search engine for the app. (local)',
      },
    ],
  },
  { key: 'mcp-server', label: 'MCP servers', items: [] },
  {
    key: 'template',
    label: 'Workbench templates',
    items: [
      {
        name: 'acme-web',
        label: 'node:22, postgres, meilisearch, claude (local)',
        desc: 'Node with Postgres and Meilisearch. (local)',
      },
    ],
  },
];

/**
 * `list-components` without --json, the listing a builder reads to see what
 * the machine has. Workbench templates are a section of it like the
 * components (#143), not only part of the JSON.
 */
describe('list-components listing', () => {
  it('pipes name<TAB>description per section, templates last, empty ones left out', () => {
    expect(renderListing(sections, false, plain)).toBe(
      [
        '# service',
        'meilisearch\tSearch engine for the app. (local)',
        'redis\tIn-memory key-value store.',
        '',
        '# template',
        'acme-web\tNode with Postgres and Meilisearch. (local)',
        '',
      ].join('\n'),
    );
  });

  it('aligns the short label on a terminal, a template showing what it brings', () => {
    expect(renderListing(sections, true, plain)).toBe(
      [
        '▸ Services',
        '',
        '  meilisearch  Meilisearch (local)',
        '  redis        Redis',
        '',
        '▸ Workbench templates',
        '',
        '  acme-web  node:22, postgres, meilisearch, claude (local)',
        '',
      ].join('\n'),
    );
  });

  it('names what a template brings the way init takes it', () => {
    expect(
      templateContents({
        name: 'acme-web',
        languages: ['node:22'],
        services: ['postgres@1', 'meilisearch@2', 'cache'],
        features: [{ name: 'claude', options: { permissionMode: 'auto' } }],
        mcpServers: ['acme-wiki'],
      }),
    ).toBe('node:22, postgres, meilisearch, cache, claude, acme-wiki');
  });
});
