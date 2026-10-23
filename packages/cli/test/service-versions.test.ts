import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogWarnings, loadDescriptorCatalog } from '../src/catalog/load.js';
import { loadDescriptorCatalogSync } from '../src/catalog/load-sync.js';

// Versioned service descriptors (#139): every version stays as a file, a
// workbench's `ref` names the one its block came from, apply reads that
// version, and upgrade merges a newer one in.

let tmp: string;
let home: string;
let services: string;
let saved: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'monoceros-versions-'));
  home = path.join(tmp, 'home');
  services = path.join(home, 'templates', 'services');
  await mkdir(services, { recursive: true });
  saved = process.env.MONOCEROS_HOME;
  process.env.MONOCEROS_HOME = home;
  vi.resetModules();
});

afterEach(async () => {
  if (saved === undefined) delete process.env.MONOCEROS_HOME;
  else process.env.MONOCEROS_HOME = saved;
  vi.resetModules();
  await rm(tmp, { recursive: true, force: true });
});

/** RabbitMQ as a team keeps it; version 2 changes the healthcheck and adds a vhost. */
const rabbit = (version: number): string => `
id: rabbitmq
category: service
version: ${version}
displayName: RabbitMQ
description: Message broker, version ${version}.
service:
  image: rabbitmq:4-management
  defaultPort: 5672
  healthcheck:
    test: [CMD, rabbitmq-diagnostics, -q, ping]
    interval: ${version === 1 ? '10s' : '5s'}
    retries: 5
  connectionEnv:
    URL: amqp://\${host}:\${port}
options:
  RABBITMQ_DEFAULT_USER:
    type: string
    default: monoceros
    surface: env
${
  version >= 2
    ? `  RABBITMQ_DEFAULT_VHOST:
    type: string
    default: monoceros
    surface: env
`
    : ''
}briefing:
  - text: 'Briefing of version ${version}.'
`;

async function writeVersions(): Promise<void> {
  await writeFile(path.join(services, 'rabbitmq.yml'), rabbit(2));
  await writeFile(path.join(services, 'rabbitmq@1.yml'), rabbit(1));
}

/** The block version 1 wrote, under the given service name. */
const V1_BLOCK = (name = 'rabbitmq'): string[] => [
  `  - name: ${name}`,
  '    ref: rabbitmq@1',
  '    image: rabbitmq:4-management',
  '    port: 5672',
  '    env:',
  '      RABBITMQ_DEFAULT_USER: ${RABBITMQ_DEFAULT_USER}',
  '    healthcheck:',
  '      test: [ "CMD", "rabbitmq-diagnostics", "-q", "ping" ]',
  '      interval: 10s',
  '      retries: 5',
  '    connectionEnv:',
  "      URL: 'amqp://${host}:${port}'",
];

const yml = (...lines: string[]): string =>
  ['schemaVersion: 1', 'name: demo', 'services:', ...lines, ''].join('\n');

describe('versioned descriptors: loading', () => {
  it('reads an older version next to the current one, in both loaders', async () => {
    await writeVersions();
    const own = path.join(home, 'templates');
    for (const catalog of [
      await loadDescriptorCatalog(path.join(tmp, 'none'), own),
      loadDescriptorCatalogSync(path.join(tmp, 'none'), own),
    ]) {
      const c = catalog.get('rabbitmq')!;
      expect(c.descriptor.version).toBe(2);
      expect([...c.older!.keys()]).toEqual([1]);
      expect(c.older!.get(1)!.descriptor.description).toBe(
        'Message broker, version 1.',
      );
    }
  });

  // A version mix-up in a template directory never stops anything: a
  // workbench may be meant to stay on an old version. The file is left out
  // and the hint names it.
  async function load() {
    const own = path.join(home, 'templates');
    const none = path.join(tmp, 'none');
    return [
      await loadDescriptorCatalog(none, own),
      loadDescriptorCatalogSync(none, own),
    ];
  }

  it('leaves out a file whose version differs from its file name', async () => {
    await writeFile(path.join(services, 'rabbitmq.yml'), rabbit(3));
    const file = path.join(services, 'rabbitmq@2.yml');
    await writeFile(file, rabbit(1));
    for (const catalog of await load()) {
      expect(catalog.get('rabbitmq')!.older).toBeUndefined();
      expect(catalogWarnings(catalog)).toEqual([
        `Left out ${file}: it carries version 1, but its file name says 2.`,
      ]);
    }
  });

  it('leaves out an older version that is not older, and keeps the current one', async () => {
    await writeFile(path.join(services, 'rabbitmq.yml'), rabbit(1));
    const file = path.join(services, 'rabbitmq@1.yml');
    await writeFile(file, rabbit(1));
    for (const catalog of await load()) {
      expect(catalog.get('rabbitmq')!.descriptor.version).toBe(1);
      expect(catalogWarnings(catalog)).toEqual([
        `Left out ${file}: it is version 1, and ${path.join(services, 'rabbitmq.yml')} is version 1. If rabbitmq.yml is a new version, raise its version.`,
      ]);
    }
  });

  it('leaves out an older version without its current file', async () => {
    await writeFile(path.join(services, 'rabbitmq@1.yml'), rabbit(1));
    for (const catalog of await load()) {
      expect(catalog.has('rabbitmq')).toBe(false);
      expect(catalogWarnings(catalog)[0]).toMatch(
        /rabbitmq\.yml next to it is missing/,
      );
    }
  });

  it('leaves out a version on an MCP server', async () => {
    const mcp = path.join(home, 'templates', 'mcp-servers');
    await mkdir(mcp, { recursive: true });
    await writeFile(path.join(mcp, 'wiki@1.yml'), 'id: wiki\n');
    for (const catalog of await load()) {
      expect(catalogWarnings(catalog)[0]).toMatch(
        /only a service descriptor has versions/,
      );
    }
  });
});

describe('versioned descriptors: what apply reads', () => {
  it('reads the briefing of the recorded version, also for a renamed instance', async () => {
    await writeVersions();
    const catalog = await import('../src/create/catalog.js');
    expect(
      catalog.curatedServiceBriefing({ name: 'queue', ref: 'rabbitmq@1' }),
    ).toEqual(['Briefing of version 1.']);
    expect(catalog.curatedServiceBriefing({ name: 'rabbitmq' })).toEqual([
      'Briefing of version 2.',
    ]);
    // Without a ref a renamed instance still finds nothing by name.
    expect(catalog.curatedServiceBriefing({ name: 'queue' })).toEqual([]);
  });

  it('hints at a missing file instead of stopping, and notes a newer version', async () => {
    await writeFile(path.join(services, 'rabbitmq.yml'), rabbit(2));
    const catalog = await import('../src/create/catalog.js');
    const svc = [{ name: 'queue', ref: 'rabbitmq@1' }];
    expect(catalog.serviceRefWarnings(svc)).toEqual([
      `Service 'queue' has ref rabbitmq@1, but ${path.join(services, 'rabbitmq@1.yml')} is not here. It runs as the yml says, without the briefing and the rest that file carries.`,
    ]);
    // A descriptor that is not on this machine at all: the same hint, and
    // apply reads nothing for it rather than stopping.
    expect(catalog.serviceRefWarnings([{ name: 'x', ref: 'ghost@1' }])).toEqual(
      [
        `Service 'x' has ref ghost@1, but ${path.join(services, 'ghost.yml')} is not here. It runs as the yml says, without the briefing and the rest that file carries.`,
      ],
    );
    expect(
      catalog.curatedServiceBriefing({ name: 'x', ref: 'ghost@1' }),
    ).toEqual([]);

    await writeFile(path.join(services, 'rabbitmq@1.yml'), rabbit(1));
    vi.resetModules();
    const fresh = await import('../src/create/catalog.js');
    expect(fresh.serviceRefWarnings(svc)).toEqual([]);
    expect(fresh.serviceRefNotes(svc, 'demo')).toEqual([
      'queue is rabbitmq version 1, version 2 is available: monoceros upgrade demo',
    ]);
  });

  it('writes the ref of the current version from add-service', async () => {
    await writeVersions();
    const catalog = await import('../src/create/catalog.js');
    expect(catalog.expandCuratedService('rabbitmq').ref).toBe('rabbitmq@2');
  });
});

describe('versioned descriptors: upgrade', () => {
  async function upgrade(text: string, replace?: string[]) {
    await writeVersions();
    const { upgradeServices } = await import('../src/upgrade/services.js');
    return upgradeServices(text, { replace });
  }

  it('brings an untouched entry up to date, keeping its comments, and reports the new env key', async () => {
    const before = yml('  # Our message broker.', ...V1_BLOCK());
    const { yml: out, results } = await upgrade(before);
    expect(results).toEqual([
      {
        kind: 'upgraded',
        service: 'rabbitmq',
        id: 'rabbitmq',
        from: 1,
        to: 2,
        newEnv: { RABBITMQ_DEFAULT_VHOST: 'monoceros' },
      },
    ]);
    expect(out).toContain('# Our message broker.');
    expect(out).toContain('    ref: rabbitmq@2');
    expect(out).toContain('      interval: 5s');
    expect(out).toContain(
      '      RABBITMQ_DEFAULT_VHOST: ${RABBITMQ_DEFAULT_VHOST}',
    );
    // The flow list the builder sees stays a flow list.
    expect(out).toMatch(/test: \[ "CMD", "rabbitmq-diagnostics"/);
  });

  it('keeps a field only the builder changed', async () => {
    const lines = V1_BLOCK().map((l) =>
      l === '    port: 5672' ? '    port: 5673' : l,
    );
    const { yml: out, results } = await upgrade(yml(...lines));
    expect(results[0]!.kind).toBe('upgraded');
    expect(out).toContain('    port: 5673');
    expect(out).toContain('      interval: 5s');
  });

  it('leaves the entry alone when the builder changed what the template changed', async () => {
    const lines = V1_BLOCK().map((l) =>
      l === '      interval: 10s' ? '      interval: 30s' : l,
    );
    const before = yml(...lines);
    const { yml: out, results } = await upgrade(before);
    expect(out).toBe(before);
    expect(results).toEqual([
      {
        kind: 'conflict',
        service: 'rabbitmq',
        id: 'rabbitmq',
        from: 1,
        to: 2,
        conflicts: [
          {
            path: 'healthcheck.interval',
            base: '10s',
            ours: '30s',
            theirs: '5s',
          },
        ],
      },
    ]);
  });

  it('replaces an edited entry with the current version on --replace', async () => {
    const lines = V1_BLOCK().map((l) =>
      l === '      interval: 10s' ? '      interval: 30s' : l,
    );
    const { yml: out, results } = await upgrade(yml(...lines), ['rabbitmq']);
    expect(results[0]!.kind).toBe('replaced');
    expect(out).toContain('      interval: 5s');
    expect(out).toContain('    ref: rabbitmq@2');
  });

  it('upgrades a renamed instance and keeps its name', async () => {
    const { yml: out, results } = await upgrade(yml(...V1_BLOCK('queue')));
    expect(results[0]).toMatchObject({ kind: 'upgraded', service: 'queue' });
    expect(out).toContain('  - name: queue');
  });

  it('stamps an entry from before versions and then upgrades it', async () => {
    const legacy = V1_BLOCK().filter((l) => !l.includes('ref:'));
    const { yml: out, results } = await upgrade(yml(...legacy));
    expect(results.map((r) => r.kind)).toEqual(['stamped', 'upgraded']);
    expect(out).toMatch(/- name: rabbitmq\n {4}ref: rabbitmq@2\n/);
  });

  it('stamps an entry from before versions with an old tag and moves the tag', async () => {
    const legacy = V1_BLOCK()
      .filter((l) => !l.includes('ref:'))
      .map((l) =>
        l === '    image: rabbitmq:4-management'
          ? '    image: rabbitmq:3-management'
          : l,
      );
    const { yml: out, results } = await upgrade(yml(...legacy));
    expect(results.map((r) => r.kind)).toEqual([
      'stamped',
      'retagged',
      'upgraded',
    ]);
    expect(out).toContain('    image: rabbitmq:4-management');
  });

  it('leaves an edited entry from before versions unstamped', async () => {
    const legacy = V1_BLOCK()
      .filter((l) => !l.includes('ref:'))
      .map((l) => (l === '    port: 5672' ? '    port: 5673' : l));
    const before = yml(...legacy);
    const { yml: out, results } = await upgrade(before);
    expect(results).toEqual([]);
    expect(out).toBe(before);
  });

  it('never touches a service written by hand', async () => {
    const before = yml('  - name: weird', '    image: acme/weird:1.2.3');
    expect(await upgrade(before)).toEqual({ yml: before, results: [] });
  });
});
