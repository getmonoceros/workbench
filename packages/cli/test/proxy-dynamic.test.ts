import { existsSync, mkdtempSync, rmSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dynamicConfigPath,
  proxyUrlsFor,
  removeDynamicConfig,
  renderDynamicConfig,
  writeDynamicConfig,
} from '../src/proxy/dynamic.js';

describe('renderDynamicConfig', () => {
  it('first port also matches the bare <name>.localhost', () => {
    const yaml = renderDynamicConfig('sandbox', [3000, 5173]);
    // first router includes both hostnames
    expect(yaml).toContain(
      'rule: "Host(`sandbox.localhost`) || Host(`sandbox-3000.localhost`)"',
    );
    // second router only the explicit one
    expect(yaml).toContain('rule: "Host(`sandbox-5173.localhost`)"');
    // never re-attach the default host to the non-first router
    expect(yaml.match(/Host\(`sandbox\.localhost`\)/g)).toHaveLength(1);
  });

  it('each port gets a load-balancer service pointing at http://<name>:<port>', () => {
    const yaml = renderDynamicConfig('api', [8080, 9229]);
    expect(yaml).toContain('- url: "http://api:8080"');
    expect(yaml).toContain('- url: "http://api:9229"');
  });

  it('emits a do-not-edit header that names the container', () => {
    const yaml = renderDynamicConfig('demo', [3000]);
    expect(yaml).toContain('# Container: demo');
    expect(yaml).toContain('# Ports: 3000');
  });

  it('is deterministic — same input yields byte-identical output', () => {
    const a = renderDynamicConfig('demo', [3000, 5173, 6006]);
    const b = renderDynamicConfig('demo', [3000, 5173, 6006]);
    expect(a).toBe(b);
  });
});

describe('renderDynamicConfig with exposed services', () => {
  it('routes a service under its prefixed alias, not the bare container name', () => {
    const yaml = renderDynamicConfig(
      'acme',
      [5173],
      [{ name: 'caddy', port: 81 }],
    );
    // the port keeps the default host, so adding a service never moves an
    // address the builder already uses
    expect(yaml).toContain(
      'rule: "Host(`acme.localhost`) || Host(`acme-5173.localhost`)"',
    );
    expect(yaml).toContain('rule: "Host(`acme-caddy.localhost`)"');
    // backend is the alias on the machine-wide proxy network, prefixed so two
    // workbenches with the same service cannot collide on it
    expect(yaml).toContain('- url: "http://acme-caddy:81"');
    expect(yaml).not.toContain('- url: "http://caddy:81"');
    expect(yaml).toContain('# Services: caddy:81');
  });

  it('works without any port, which is a workbench fronted by a service', () => {
    const yaml = renderDynamicConfig(
      'acme',
      [],
      [{ name: 'keycloak', port: 8080 }],
    );
    expect(yaml).toContain('rule: "Host(`acme-keycloak.localhost`)"');
    expect(yaml).toContain('- url: "http://acme-keycloak:8080"');
    // nothing claims the bare host when no port is declared
    expect(yaml).not.toContain('Host(`acme.localhost`)');
    expect(yaml).toContain('# Ports: (none)');
  });

  it('gives every exposed service its own router and backend', () => {
    const yaml = renderDynamicConfig(
      'acme',
      [],
      [
        { name: 'keycloak', port: 8080 },
        { name: 'mailpit', port: 8025 },
      ],
    );
    expect(yaml).toContain('rule: "Host(`acme-keycloak.localhost`)"');
    expect(yaml).toContain('rule: "Host(`acme-mailpit.localhost`)"');
    expect(yaml).toContain('- url: "http://acme-mailpit:8025"');
  });
});

describe('writeDynamicConfig / removeDynamicConfig', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'monoceros-dyn-'));
  });

  afterEach(() => {
    if (home && existsSync(home))
      rmSync(home, { recursive: true, force: true });
  });

  it('creates the dynamic dir on demand and writes the file', async () => {
    const file = await writeDynamicConfig('sandbox', [3000], {
      monocerosHome: home,
    });
    expect(existsSync(file)).toBe(true);
    expect(file).toBe(dynamicConfigPath('sandbox', { monocerosHome: home }));
    const body = await fs.readFile(file, 'utf8');
    expect(body).toContain('http://sandbox:3000');
  });

  it('writes a file for a workbench with only an exposed service', async () => {
    const file = await writeDynamicConfig('acme', [], {
      monocerosHome: home,
      services: [{ name: 'caddy', port: 81 }],
    });
    const body = await fs.readFile(file, 'utf8');
    expect(body).toContain('Host(`acme-caddy.localhost`)');
  });

  it('rejects an empty port list with a hint at the alternative', async () => {
    await expect(
      writeDynamicConfig('sandbox', [], { monocerosHome: home }),
    ).rejects.toThrow(/removeDynamicConfig\("sandbox"\)/);
  });

  it('overwrites an existing file (idempotent re-application)', async () => {
    await writeDynamicConfig('sandbox', [3000], { monocerosHome: home });
    await writeDynamicConfig('sandbox', [3000, 5173], { monocerosHome: home });
    const file = dynamicConfigPath('sandbox', { monocerosHome: home });
    const body = await fs.readFile(file, 'utf8');
    expect(body).toContain('sandbox-5173');
  });

  it('removeDynamicConfig deletes the file', async () => {
    await writeDynamicConfig('sandbox', [3000], { monocerosHome: home });
    const file = dynamicConfigPath('sandbox', { monocerosHome: home });
    expect(existsSync(file)).toBe(true);
    await removeDynamicConfig('sandbox', { monocerosHome: home });
    expect(existsSync(file)).toBe(false);
  });

  it('removeDynamicConfig is a no-op when the file is absent', async () => {
    await expect(
      removeDynamicConfig('ghost', { monocerosHome: home }),
    ).resolves.toBeUndefined();
  });
});

describe('proxyUrlsFor', () => {
  it('marks the first port as default', () => {
    const urls = proxyUrlsFor('sandbox', [3000, 5173, 6006]);
    expect(urls).toEqual([
      { port: 3000, url: 'http://sandbox-3000.localhost', isDefault: true },
      { port: 5173, url: 'http://sandbox-5173.localhost', isDefault: false },
      { port: 6006, url: 'http://sandbox-6006.localhost', isDefault: false },
    ]);
  });

  it('handles a single-port container', () => {
    const urls = proxyUrlsFor('api', [3000]);
    expect(urls).toEqual([
      { port: 3000, url: 'http://api-3000.localhost', isDefault: true },
    ]);
  });

  it('returns an empty list for no ports', () => {
    expect(proxyUrlsFor('sandbox', [])).toEqual([]);
  });

  it('suffixes the host port when not 80', () => {
    const urls = proxyUrlsFor('sandbox', [3000, 5173], 8080);
    expect(urls.map((u) => u.url)).toEqual([
      'http://sandbox-3000.localhost:8080',
      'http://sandbox-5173.localhost:8080',
    ]);
  });

  it('omits the host port when explicitly 80', () => {
    const urls = proxyUrlsFor('sandbox', [3000], 80);
    expect(urls[0]!.url).toBe('http://sandbox-3000.localhost');
  });
});
