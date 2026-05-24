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
});
