import { describe, expect, it } from 'vitest';
import { parseDescriptorFile } from '../src/catalog/load.js';
import type { CatalogComponent } from '../src/catalog/load.js';
import { isInlineMcpEntry, resolveMcpServers } from '../src/catalog/mcp.js';
import { validateConfig } from '../src/config/schema.js';
import type { McpEntry } from '../src/config/schema.js';

const CONNECTOR_YML = `
id: context7
category: mcp-server
displayName: Context7
description: 'Current library docs.'
documentationURL: https://context7.com
options:
  apiKey:
    type: string
    default: ''
    surface: env
mcpServer:
  transport: http
  url: https://mcp.context7.com/mcp
  headers:
    CONTEXT7_API_KEY: '\${apiKey}'
briefing:
  - text: 'Look it up before you write against it.'
`;

const STDIO_YML = `
id: localthing
category: mcp-server
displayName: Local Thing
description: 'Runs in the container.'
options:
  mode:
    type: string
    default: fast
    surface: yml
mcpServer:
  transport: stdio
  command: npx
  args: ['-y', 'local-thing', '--mode=\${mode}']
`;

function catalogOf(...ymls: string[]): Map<string, CatalogComponent> {
  const out = new Map<string, CatalogComponent>();
  for (const yml of ymls) {
    const id = /^id:\s*(\S+)$/m.exec(yml)![1]!;
    const c = parseDescriptorFile(
      yml,
      `/fake/${id}/component.yml`,
      id,
      'mcp-server',
    );
    out.set(c.id, c);
  }
  return out;
}

const entry = (e: Partial<McpEntry> & { name: string }): McpEntry =>
  e as McpEntry;

describe('descriptor mcp block', () => {
  it('rejects a stdio block without a command', () => {
    expect(() =>
      catalogOf(`
id: broken
category: mcp-server
displayName: Broken
description: 'x'
mcpServer:
  transport: stdio
`),
    ).toThrow(/requires `command`/);
  });

  it('rejects a remote field on a stdio block', () => {
    expect(() =>
      catalogOf(`
id: broken
category: mcp-server
displayName: Broken
description: 'x'
mcpServer:
  transport: stdio
  command: server
  url: https://example.test
`),
    ).toThrow(/`url` has no meaning for transport 'stdio'/);
  });

  it('rejects a template referencing an undeclared option', () => {
    expect(() =>
      catalogOf(`
id: broken
category: mcp-server
displayName: Broken
description: 'x'
mcpServer:
  transport: http
  url: https://example.test
  headers:
    KEY: '\${nope}'
`),
    ).toThrow(/references '\$\{nope\}', which is not a declared option/);
  });

  it('rejects an mcp block on a non-mcp category', () => {
    expect(() =>
      parseDescriptorFile(
        `
id: mixed
category: mcp-server
displayName: Mixed
description: 'x'
feature:
  version: 1.0.0
mcpServer:
  transport: http
  url: https://example.test
`,
        '/fake/mixed/component.yml',
        'mixed',
        'mcp-server',
      ),
    ).toThrow(/exactly one of language\/service\/feature\/mcp/);
  });
});

describe('yml mcp entries', () => {
  const config = (servers: unknown[]): unknown => ({
    schemaVersion: 1,
    name: 'acme',
    mcpServers: servers,
  });

  it('accepts a bare reference and an inline definition', () => {
    const parsed = validateConfig(
      config([
        { name: 'context7', options: { apiKey: '${CONTEXT7_API_KEY}' } },
        {
          name: 'notion',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@notionhq/notion-mcp-server'],
        },
      ]),
    );
    expect(parsed.mcpServers).toHaveLength(2);
    expect(isInlineMcpEntry(parsed.mcpServers[0]!)).toBe(false);
    expect(isInlineMcpEntry(parsed.mcpServers[1]!)).toBe(true);
  });

  it('rejects options together with a definition', () => {
    expect(() =>
      validateConfig(
        config([
          {
            name: 'notion',
            transport: 'stdio',
            command: 'npx',
            options: { apiKey: 'x' },
          },
        ]),
      ),
    ).toThrow(/`options` belongs to a catalog connector/);
  });

  it('requires a transport on an inline entry', () => {
    expect(() =>
      validateConfig(config([{ name: 'notion', command: 'npx' }])),
    ).toThrow(/needs `transport`/);
  });

  it('rejects a duplicate server name', () => {
    expect(() =>
      validateConfig(config([{ name: 'context7' }, { name: 'context7' }])),
    ).toThrow(/Duplicate MCP server name 'context7'/);
  });

  it('accepts the punctuation real-world server names use', () => {
    const parsed = validateConfig(
      config([{ name: 'chrome-devtools' }, { name: 'sentry_v2' }]),
    );
    expect(parsed.mcpServers.map((m) => m.name)).toEqual([
      'chrome-devtools',
      'sentry_v2',
    ]);
  });

  it('defaults to an empty list, so an old yml still parses', () => {
    expect(
      validateConfig({ schemaVersion: 1, name: 'acme' }).mcpServers,
    ).toEqual([]);
  });
});

describe('resolveMcpServers', () => {
  const catalog = catalogOf(CONNECTOR_YML, STDIO_YML);

  it('renders a connector template from its options', () => {
    const { servers } = resolveMcpServers(
      [entry({ name: 'context7', options: { apiKey: 'ctx7sk-1' } })],
      catalog,
    );
    expect(servers).toEqual([
      {
        name: 'context7',
        transport: 'http',
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: 'ctx7sk-1' },
        description: 'Current library docs.',
        briefing: ['Look it up before you write against it.'],
        fromCatalog: true,
      },
    ]);
  });

  it('falls back to a declared default when the yml leaves an option empty', () => {
    const { servers } = resolveMcpServers(
      [entry({ name: 'localthing', options: { mode: '' } })],
      catalog,
    );
    expect(servers[0]!.args).toEqual(['-y', 'local-thing', '--mode=fast']);
  });

  it('refuses a credential that resolves empty instead of registering it', () => {
    expect(() =>
      resolveMcpServers([entry({ name: 'context7' })], catalog),
    ).toThrow(
      /option 'apiKey' is empty, but headers.CONTEXT7_API_KEY needs it/,
    );
  });

  it('reports an unknown option against the connector', () => {
    expect(() =>
      resolveMcpServers(
        [entry({ name: 'localthing', options: { nope: 'x' } })],
        catalog,
      ),
    ).toThrow(/unknown option 'nope'\. Declared options: mode/);
  });

  it('lists the catalog for an unknown name', () => {
    expect(() =>
      resolveMcpServers([entry({ name: 'ghost' })], catalog),
    ).toThrow(/unknown connector\. Catalog connectors: context7, localthing/);
  });

  it('points at the right command when the name is another category', () => {
    const mixed = new Map(catalog);
    mixed.set(
      'postgres',
      parseDescriptorFile(
        `
id: postgres
category: service
displayName: Postgres
description: 'db'
service:
  image: postgres:18
`,
        '/fake/postgres/component.yml',
        'postgres',
        'service',
      ),
    );
    expect(() =>
      resolveMcpServers([entry({ name: 'postgres' })], mixed),
    ).toThrow(
      /that is a service, not an MCP connector.*monoceros add-service/s,
    );
  });

  it('passes an inline entry through untouched', () => {
    const { servers } = resolveMcpServers(
      [
        entry({
          name: 'notion',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@notionhq/notion-mcp-server'],
          env: { NOTION_TOKEN: 'ntn_1' },
        }),
      ],
      catalog,
    );
    expect(servers[0]).toEqual({
      name: 'notion',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: { NOTION_TOKEN: 'ntn_1' },
      fromCatalog: false,
    });
  });

  it('does not resolve an inline entry that shadows a connector, but says so', () => {
    const { servers, notes } = resolveMcpServers(
      [
        entry({
          name: 'context7',
          transport: 'stdio',
          command: 'my-own-context7',
        }),
      ],
      catalog,
    );
    expect(servers[0]!.command).toBe('my-own-context7');
    expect(servers[0]!.fromCatalog).toBe(false);
    expect(notes[0]).toMatch(/shadows the catalog connector/);
  });

  it('collects every problem before it throws', () => {
    expect(() =>
      resolveMcpServers(
        [entry({ name: 'ghost' }), entry({ name: 'context7' })],
        catalog,
      ),
    ).toThrow(/ghost[\s\S]*context7/);
  });
});
