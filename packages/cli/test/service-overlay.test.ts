import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { loadDescriptorCatalogSync } from '../src/catalog/load-sync.js';
import { expandSelectable } from '../src/catalog/expand.js';

// The builder's own services, <MONOCEROS_HOME>/templates/services/<id>.yml
// (ADR 0063): laid over the shipped catalog, theirs wins by id.

let tmp: string;
let shipped: string;
let own: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'monoceros-overlay-'));
  shipped = path.join(tmp, 'shipped');
  own = path.join(tmp, 'home', 'templates');
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** The builder's own service: one flat `<own>/services/<id>.yml`. */
async function writeOwn(id: string, yml: string): Promise<string> {
  await mkdir(path.join(own, 'services'), { recursive: true });
  const file = path.join(own, 'services', `${id}.yml`);
  await writeFile(file, yml, 'utf8');
  return file;
}

async function writeDescriptor(
  root: string,
  categoryDir: string,
  id: string,
  yml: string,
): Promise<string> {
  const dir = path.join(root, categoryDir, id);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'component.yml');
  await writeFile(file, yml, 'utf8');
  return file;
}

const service = (id: string, image: string, extra = ''): string => `
id: ${id}
category: service
displayName: ${id}
description: The ${id} service.
service:
  image: ${image}
  defaultPort: 9092
${extra}`;

const KAFKA = service(
  'kafka',
  'confluentinc/cp-kafka:7.7.0',
  `  connectionEnv:
    BOOTSTRAP: \${host}:\${port}
`,
);

const FEATURE_GH = `
id: gh
category: feature
displayName: GitHub CLI
description: gh.
feature:
  version: 1.0.0
`;

describe('service overlay: loading', () => {
  it('adds a service of the builder and replaces a shipped one by id, both marked local', async () => {
    await writeDescriptor(
      shipped,
      'services',
      'postgres',
      service('postgres', 'postgres:18'),
    );
    await writeDescriptor(
      shipped,
      'services',
      'redis',
      service('redis', 'redis:8'),
    );
    await writeOwn('postgres', service('postgres', 'postgres:17'));
    await writeOwn('kafka', KAFKA);

    for (const catalog of [
      await loadDescriptorCatalog(shipped, own),
      loadDescriptorCatalogSync(shipped, own),
    ]) {
      expect([...catalog.keys()].sort()).toEqual([
        'kafka',
        'postgres',
        'redis',
      ]);
      expect(catalog.get('postgres')!.descriptor.service!.image).toBe(
        'postgres:17',
      );
      expect(catalog.get('postgres')!.local).toBe(true);
      expect(catalog.get('kafka')!.local).toBe(true);
      expect(catalog.get('redis')!.local).toBeUndefined();
      expect(expandSelectable(catalog).get('kafka')!.local).toBe(true);
    }
  });

  it('reads only templates/services/*.yml, not the workbench templates next to it', async () => {
    await mkdir(path.join(own, 'workbenches'), { recursive: true });
    await writeFile(path.join(own, 'workbenches', 'standard.yml'), 'name: x\n');
    await mkdir(path.join(own, 'services', 'old-folder'), { recursive: true });
    await writeFile(path.join(own, 'services', 'notes.txt'), 'x');
    const catalog = await loadDescriptorCatalog(shipped, own);
    expect(catalog.size).toBe(0);
  });

  it('names the file when its id differs from the file name', async () => {
    await writeOwn('kafka', service('other', 'x:1'));
    await expect(loadDescriptorCatalog(shipped, own)).rejects.toThrow(
      /must match its file name 'kafka'/,
    );
  });

  it('refuses tools on a new service, and keeps them under a shipped id', async () => {
    const tools = '  tools: [kc-admin]\n';
    await writeDescriptor(
      shipped,
      'services',
      'keycloak',
      service('keycloak', 'keycloak:26', tools),
    );
    await writeOwn('keycloak', service('keycloak', 'keycloak:27', tools));
    expect(
      (await loadDescriptorCatalog(shipped, own)).get('keycloak')!.local,
    ).toBe(true);
    const file = await writeOwn('kafka', service('kafka', 'x:1', tools));
    await expect(loadDescriptorCatalog(shipped, own)).rejects.toThrow(file);
  });

  it('names the file when a service of the builder takes the id of a shipped feature', async () => {
    await writeDescriptor(shipped, 'features', 'gh', FEATURE_GH);
    const file = await writeOwn('gh', service('gh', 'x:1'));
    await expect(loadDescriptorCatalog(shipped, own)).rejects.toThrow(file);
    expect(() => loadDescriptorCatalogSync(shipped, own)).toThrow(
      /shipped feature 'gh'/,
    );
  });

  it('names the file when a service of the builder takes the name a shipped feature is selected by', async () => {
    await writeDescriptor(
      shipped,
      'features',
      'claude-code',
      FEATURE_GH.replace('id: gh', 'id: claude-code\nname: claude'),
    );
    const file = await writeOwn('claude', service('claude', 'x:1'));
    await expect(loadDescriptorCatalog(shipped, own)).rejects.toThrow(file);
  });

  it('names the file when a descriptor of the builder is invalid', async () => {
    const file = await writeOwn('kafka', 'id: kafka\ncategory: service\n');
    await expect(loadDescriptorCatalog(shipped, own)).rejects.toThrow(file);
  });

  it('an explicit root alone never reads the home (the published catalog stays shipped-only)', async () => {
    await writeDescriptor(
      shipped,
      'services',
      'redis',
      service('redis', 'redis:8'),
    );
    const catalog = await loadDescriptorCatalog(shipped);
    expect([...catalog.keys()]).toEqual(['redis']);
  });
});

// The eager SERVICE_CATALOG is built at import from MONOCEROS_HOME, so these
// re-import the module graph against a temp home.
describe('service overlay: the catalog a command sees', () => {
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

  it('add-service bakes a service of the builder into the yml, connectionEnv included', async () => {
    await writeOwn('kafka', KAFKA);
    const catalog = await import('../src/create/catalog.js');
    expect(catalog.knownServices()).toContain('kafka');
    expect(catalog.knownServices()).toContain('postgres');

    const { runAddService } = await import('../src/modify/index.js');
    await runAddService({
      name: 'demo',
      service: 'kafka',
      monocerosHome: home,
      logger: silent,
    });
    const yml = await readFile(
      path.join(home, 'container-configs', 'demo.yml'),
      'utf8',
    );
    expect(yml).toContain('image: confluentinc/cp-kafka:7.7.0');
    expect(yml).toContain('port: 9092');
    // The header says what it is, but links no page: there is none.
    expect(yml).toMatch(/^\s*# kafka: The kafka service\.$/m);
    expect(yml).not.toMatch(/docs\/services\/kafka/);
    // Baked, so the yml works on a machine without the descriptor: apply
    // reads the templates off the service, not off the catalog.
    expect(yml).toContain("BOOTSTRAP: '${host}:${port}'");
    const { parseConfig } = await import('../src/config/index.js');
    const { solutionConfigToCreateOptions } =
      await import('../src/config/transform.js');
    const opts = solutionConfigToCreateOptions(parseConfig(yml).config);
    expect(catalog.serviceConnectionEnv(opts.services)).toEqual({
      KAFKA_BOOTSTRAP: 'kafka:9092',
    });
  });

  it('init --with-services takes a service of the builder by name', async () => {
    await writeOwn('kafka', KAFKA);
    const { runInit } = await import('../src/init/index.js');
    const result = await runInit({
      name: 'fresh',
      services: ['kafka'],
      monocerosHome: home,
      logger: silent,
    });
    const yml = await readFile(result.configPath, 'utf8');
    expect(yml).toContain('  - name: kafka');
    expect(yml).toContain('    image: confluentinc/cp-kafka:7.7.0');
  });

  it('a broken descriptor does not break the import, and add-service names it', async () => {
    const file = await writeOwn('kafka', 'id: kafka\n');
    const catalog = await import('../src/create/catalog.js');
    expect(catalog.knownServices()).not.toContain('kafka');
    expect(catalog.knownServices()).toContain('postgres');

    const { runAddService } = await import('../src/modify/index.js');
    await expect(
      runAddService({
        name: 'demo',
        service: 'kafka',
        monocerosHome: home,
        logger: silent,
      }),
    ).rejects.toThrow(file);
  });
});
