import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { loadDescriptorCatalogSync } from '../src/catalog/load-sync.js';
import { resolveMcpServers } from '../src/catalog/mcp.js';

// The builder's own MCP servers, <MONOCEROS_HOME>/templates/mcp-servers/<id>.yml
// (ADR 0063, #134): laid over the shipped catalog like own services, written
// into the yml by name, and resolved at apply from the file, briefing included.

let tmp: string;
let shipped: string;
let own: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'monoceros-mcp-overlay-'));
  shipped = path.join(tmp, 'shipped');
  own = path.join(tmp, 'home', 'templates');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeOwn(dir: string, id: string, yml: string): Promise<string> {
  await mkdir(path.join(own, dir), { recursive: true });
  const file = path.join(own, dir, `${id}.yml`);
  await writeFile(file, yml, 'utf8');
  return file;
}

async function writeShipped(
  categoryDir: string,
  id: string,
  yml: string,
): Promise<void> {
  const dir = path.join(shipped, categoryDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'component.yml'), yml, 'utf8');
}

const mcp = (id: string, url: string): string => `
id: ${id}
category: mcp-server
displayName: ${id}
description: The ${id} server.
options:
  token:
    type: string
    default: ''
    surface: env
mcpServer:
  transport: http
  url: ${url}
  headers:
    Authorization: 'Bearer \${token}'
briefing:
  - text: 'Search the ${id} wiki before you guess.'
`;

const SERVICE_WIKI = `
id: wiki
category: service
displayName: wiki
description: A wiki service.
service:
  image: wiki:1
`;

describe('mcp overlay: loading', () => {
  it('adds an MCP server of the builder and replaces a shipped one by id, both marked local', async () => {
    await writeShipped('mcp-servers', 'context7', mcp('context7', 'https://a'));
    await writeShipped('mcp-servers', 'linear', mcp('linear', 'https://l'));
    await writeOwn('mcp-servers', 'context7', mcp('context7', 'https://own'));
    await writeOwn('mcp-servers', 'acme-wiki', mcp('acme-wiki', 'https://w'));

    for (const catalog of [
      await loadDescriptorCatalog(shipped, own),
      loadDescriptorCatalogSync(shipped, own),
    ]) {
      expect([...catalog.keys()].sort()).toEqual([
        'acme-wiki',
        'context7',
        'linear',
      ]);
      expect(catalog.get('context7')!.descriptor.mcpServer!.url).toBe(
        'https://own',
      );
      expect(catalog.get('context7')!.local).toBe(true);
      expect(catalog.get('acme-wiki')!.local).toBe(true);
      expect(catalog.get('linear')!.local).toBeUndefined();
    }
  });

  it('names the file when its id differs from the file name', async () => {
    await writeOwn('mcp-servers', 'acme-wiki', mcp('other', 'https://w'));
    await expect(loadDescriptorCatalog(shipped, own)).rejects.toThrow(
      /must match its file name 'acme-wiki'/,
    );
  });

  it('names the file when an MCP server of the builder takes the name of a shipped service', async () => {
    await writeShipped('services', 'wiki', SERVICE_WIKI);
    const file = await writeOwn(
      'mcp-servers',
      'wiki',
      mcp('wiki', 'https://w'),
    );
    await expect(loadDescriptorCatalog(shipped, own)).rejects.toThrow(
      `MCP server 'wiki' (${file}) has the name of the shipped service 'wiki'`,
    );
  });

  it('refuses an own service and an own MCP server under the same id', async () => {
    await writeOwn('services', 'wiki', SERVICE_WIKI);
    await writeOwn('mcp-servers', 'wiki', mcp('wiki', 'https://w'));
    await expect(loadDescriptorCatalog(shipped, own)).rejects.toThrow(
      /Duplicate component id 'wiki'/,
    );
  });

  it('names the file when a descriptor of the builder sits in the wrong directory', async () => {
    const file = await writeOwn('mcp-servers', 'wiki', SERVICE_WIKI);
    await expect(loadDescriptorCatalog(shipped, own)).rejects.toThrow(file);
  });

  it('resolves url, headers and briefing from the file at apply', async () => {
    await writeOwn('mcp-servers', 'acme-wiki', mcp('acme-wiki', 'https://w'));
    const catalog = await loadDescriptorCatalog(shipped, own);
    const { servers } = resolveMcpServers(
      [{ name: 'acme-wiki', options: { token: 'secret' } }],
      catalog,
    );
    expect(servers).toEqual([
      expect.objectContaining({
        name: 'acme-wiki',
        transport: 'http',
        url: 'https://w',
        headers: { Authorization: 'Bearer secret' },
        briefing: ['Search the acme-wiki wiki before you guess.'],
        fromCatalog: true,
      }),
    ]);
  });
});

describe('mcp overlay: the commands that write the yml', () => {
  let saved: string | undefined;
  let home: string;

  beforeEach(async () => {
    saved = process.env.MONOCEROS_HOME;
    home = path.join(tmp, 'home');
    process.env.MONOCEROS_HOME = home;
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    await writeFile(
      path.join(home, 'container-configs', 'demo.yml'),
      'schemaVersion: 1\nname: demo\n',
    );
    vi.resetModules();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.MONOCEROS_HOME;
    else process.env.MONOCEROS_HOME = saved;
    vi.resetModules();
  });

  const silent = { info: () => {}, success: () => {}, warn: () => {} };

  it('add-mcp-server writes it by name, links no page and seeds the credential', async () => {
    await writeOwn('mcp-servers', 'acme-wiki', mcp('acme-wiki', 'https://w'));
    const { runAddMcpServer } = await import('../src/modify/index.js');
    await runAddMcpServer({
      name: 'demo',
      connector: 'acme-wiki',
      monocerosHome: home,
      yes: true,
      logger: silent,
    });
    const yml = await readFile(
      path.join(home, 'container-configs', 'demo.yml'),
      'utf8',
    );
    expect(yml).toContain('  - name: acme-wiki');
    expect(yml).toContain('token: ${ACME_WIKI_TOKEN}');
    // By name only: apply resolves the definition from the file.
    expect(yml).not.toContain('https://w');
    expect(yml).toMatch(/^\s*# acme-wiki: The acme-wiki server\.$/m);
    expect(yml).not.toMatch(/docs\/mcp-servers\/acme-wiki/);
    const env = await readFile(
      path.join(home, 'container-configs', 'demo.env'),
      'utf8',
    );
    expect(env).toContain('ACME_WIKI_TOKEN=');
  });

  it('init --with-mcp-servers takes an MCP server of the builder by name', async () => {
    await writeOwn('mcp-servers', 'acme-wiki', mcp('acme-wiki', 'https://w'));
    const { runInit } = await import('../src/init/index.js');
    const result = await runInit({
      name: 'fresh',
      mcpServers: ['acme-wiki'],
      monocerosHome: home,
      yes: true,
      logger: silent,
    });
    const yml = await readFile(result.configPath, 'utf8');
    expect(yml).toContain('  - name: acme-wiki');
    expect(yml).not.toMatch(/docs\/mcp-servers\/acme-wiki/);
  });
});
