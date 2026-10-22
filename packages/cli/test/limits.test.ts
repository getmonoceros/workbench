import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateConfig } from '../src/config/schema.js';
import { loadDescriptorCatalog } from '../src/catalog/load.js';
import { componentsRootDir } from '../src/config/paths.js';
import {
  buildComposeYaml,
  buildDevcontainerJson,
  normalizeOptions,
} from '../src/create/scaffold.js';
import type { CreateOptions, ResolvedService } from '../src/create/types.js';
import type { DockerLookupExec } from '../src/devcontainer/locate-running.js';
import {
  applyEffectiveLimits,
  effectiveLimits,
  explainExit137,
  findOomKills,
  formatFitWarning,
  formatLimits,
  formatOomKill,
} from '../src/limits/index.js';
import { gatherStatus, statusJson } from '../src/status/index.js';
import { memoryBytes } from '../src/util/memory.js';

/**
 * ADR 0062: a figure in the yml is always enforced; the catalog defaults only
 * on a machine that switches them on.
 */

const svc = (
  name: string,
  image: string,
  extra: Partial<ResolvedService> = {},
): ResolvedService => ({ name, image, env: {}, volumes: [], ...extra });

const base = (extra: Partial<CreateOptions> = {}): CreateOptions => ({
  name: 'acme',
  languages: [],
  services: [],
  ...extra,
});

const ctx = {
  ymlPath: '/home/container-configs/acme.yml',
  globalEnvPath: '/home/monoceros-config.env',
  home: '/home',
};

describe('memory figures', () => {
  it('reads Docker notation into bytes', () => {
    expect(memoryBytes('512m')).toBe(512 * 1024 ** 2);
    expect(memoryBytes('1.5g')).toBe(1.5 * 1024 ** 3);
    expect(memoryBytes('2G')).toBe(2 * 1024 ** 3);
    expect(memoryBytes('512')).toBeNaN();
  });
});

describe('yml schema: resources', () => {
  const yml = (resources: unknown) => ({
    schemaVersion: 1,
    name: 'acme',
    resources,
    services: [{ name: 'postgres', image: 'postgres:18', resources }],
  });

  it('accepts memory and cpus on the workspace and on a service', () => {
    const cfg = validateConfig(yml({ memory: '2g', cpus: 1.5 }));
    expect(cfg.resources).toEqual({ memory: '2g', cpus: 1.5 });
    expect(cfg.services[0]!.resources).toEqual({ memory: '2g', cpus: 1.5 });
  });

  // Docker reads a bare number as bytes: `512` would be a 512-byte limit.
  it('rejects a memory figure without a unit', () => {
    expect(() => validateConfig(yml({ memory: '512' }))).toThrow(
      /resources\.memory: Invalid memory/,
    );
  });

  it('rejects memory below what Docker accepts, zero cpus, and an empty block', () => {
    expect(() => validateConfig(yml({ memory: '4m' }))).toThrow(/at least 6m/);
    expect(() => validateConfig(yml({ cpus: 0 }))).toThrow(/greater than 0/);
    expect(() => validateConfig(yml({}))).toThrow(/memory, cpus, or both/);
  });

  it('rejects an unknown key, so a typo is not a silent no-limit', () => {
    expect(() => validateConfig(yml({ mem: '1g' }))).toThrow(/mem/);
  });
});

describe('catalog defaults', () => {
  it('every shipped service carries a default memory and cpus figure', async () => {
    const catalog = await loadDescriptorCatalog(componentsRootDir());
    const services = [...catalog.values()].filter(
      (c) => c.descriptor.category === 'service',
    );
    expect(services.length).toBeGreaterThan(0);
    for (const c of services) {
      expect(c.descriptor.service?.resources, c.descriptor.id).toBeDefined();
    }
  });
});

describe('effectiveLimits', () => {
  const opts = base({
    services: [
      svc('postgres', 'postgres:18'),
      // added with `--as analytics`: found by image
      svc('analytics', 'postgres:18'),
      svc('rabbitmq', 'rabbitmq:4'),
    ],
  });

  it('enforces nothing without a yml figure and with the switch off', () => {
    const limits = effectiveLimits(opts, false);
    expect(limits.map((l) => l.name)).toEqual([
      'workspace',
      'postgres',
      'analytics',
      'rabbitmq',
    ]);
    expect(limits.every((l) => !l.memory && !l.cpus)).toBe(true);
  });

  it('enforces a yml figure with the switch off', () => {
    const limits = effectiveLimits(
      base({
        resources: { memory: '6g' },
        services: [svc('postgres', 'postgres:18', { resources: { cpus: 2 } })],
      }),
      false,
    );
    expect(limits).toEqual([
      { name: 'workspace', memory: '6g' },
      { name: 'postgres', cpus: 2 },
    ]);
  });

  it('fills in the catalog defaults with the switch on, by name and by image', () => {
    const limits = effectiveLimits(opts, true);
    expect(limits).toEqual([
      { name: 'workspace', memory: '4g', cpus: 2 },
      { name: 'postgres', memory: '512m', cpus: 1 },
      { name: 'analytics', memory: '512m', cpus: 1 },
      { name: 'rabbitmq' },
    ]);
  });

  it('lets the yml override a default field by field', () => {
    const limits = effectiveLimits(
      base({
        services: [
          svc('postgres', 'postgres:18', { resources: { memory: '2g' } }),
        ],
      }),
      true,
    );
    expect(limits[1]).toEqual({ name: 'postgres', memory: '2g', cpus: 1 });
  });
});

describe('applyEffectiveLimits', () => {
  it('writes the effective limits onto the create options', () => {
    const opts = base({ services: [svc('postgres', 'postgres:18')] });
    applyEffectiveLimits(opts, true, ctx);
    expect(opts.resources).toEqual({ memory: '4g', cpus: 2 });
    expect(opts.services[0]!.resources).toEqual({ memory: '512m', cpus: 1 });
  });

  it('refuses a service without a memory figure when the defaults are enforced', () => {
    const opts = base({ services: [svc('rabbitmq', 'rabbitmq:4')] });
    expect(() => applyEffectiveLimits(opts, true, ctx)).toThrow(
      /rabbitmq has no memory limit.*MONOCEROS_ENFORCE_DEFAULT_LIMITS[\s\S]*- name: rabbitmq[\s\S]*templates\/services\/rabbitmq\.yml/,
    );
  });

  it('accepts that service once the yml gives it a memory figure', () => {
    const opts = base({
      services: [
        svc('rabbitmq', 'rabbitmq:4', { resources: { memory: '512m' } }),
      ],
    });
    expect(() => applyEffectiveLimits(opts, true, ctx)).not.toThrow();
  });

  it('leaves a container without a limit alone when nothing is enforced', () => {
    const opts = base({ services: [svc('rabbitmq', 'rabbitmq:4')] });
    applyEffectiveLimits(opts, false, ctx);
    expect(opts.resources).toBeUndefined();
    expect(opts.services[0]!.resources).toBeUndefined();
  });
});

describe('the limits in the generated files', () => {
  // apply normalizes the options before it computes the limits; a real run
  // showed the workspace at its 4g default although the yml said 3g.
  it('normalizeOptions keeps the workspace limit from the yml', () => {
    expect(
      normalizeOptions(base({ resources: { memory: '3g' } })).resources,
    ).toEqual({ memory: '3g' });
  });

  it('compose mode: deploy.resources.limits on the workspace and the service', () => {
    const compose = parseYaml(
      buildComposeYaml(
        base({
          resources: { memory: '4g', cpus: 2 },
          services: [
            svc('postgres', 'postgres:18', {
              resources: { memory: '512m', cpus: 0.5 },
            }),
            svc('redis', 'redis:8'),
          ],
        }),
      ),
    ) as {
      services: Record<string, { deploy?: unknown }>;
    };
    expect(compose.services.workspace!.deploy).toEqual({
      resources: { limits: { memory: '4g', cpus: '2' } },
    });
    expect(compose.services.postgres!.deploy).toEqual({
      resources: { limits: { memory: '512m', cpus: '0.5' } },
    });
    expect(compose.services.redis!.deploy).toBeUndefined();
  });

  it('image mode: --memory and --cpus on the run args', () => {
    const dc = buildDevcontainerJson(
      base({ resources: { memory: '3g', cpus: 1.5 } }),
    ) as { runArgs: string[] };
    expect(dc.runArgs).toContain('--memory=3g');
    expect(dc.runArgs).toContain('--cpus=1.5');
  });

  it('image mode without a limit adds neither', () => {
    const dc = buildDevcontainerJson(base()) as { runArgs: string[] };
    expect(dc.runArgs.some((a) => a.startsWith('--memory'))).toBe(false);
    expect(dc.runArgs.some((a) => a.startsWith('--cpus'))).toBe(false);
  });
});

describe('formatLimits / formatFitWarning', () => {
  const limits = [
    { name: 'workspace', memory: '4g', cpus: 2 },
    { name: 'postgres', memory: '512m', cpus: 1 },
    { name: 'rabbitmq' },
  ];

  it('names every container with a limit', () => {
    expect(formatLimits(limits)).toBe(
      'workspace 4g, 2 CPUs · postgres 512m, 1 CPU',
    );
  });

  it('warns when the limits add up to more than Docker has', () => {
    expect(formatFitWarning(limits, 4 * 1024 ** 3, ctx.ymlPath)).toMatch(
      /add up to 4\.5 GiB, but Docker has 4 GiB in total/,
    );
  });

  it('is quiet when they fit, or when Docker cannot say', () => {
    expect(
      formatFitWarning(limits, 8 * 1024 ** 3, ctx.ymlPath),
    ).toBeUndefined();
    expect(formatFitWarning(limits, undefined, ctx.ymlPath)).toBeUndefined();
  });
});

/**
 * Docker fake for the OOM lookup. The answers mirror what Docker 29.6 printed
 * in a real run: OOMKilled=true on a running workspace whose child process was
 * killed, and on a service caught in a restart loop.
 */
function oomDocker(inspectRows: string[]): DockerLookupExec {
  return async (args) => {
    const a = args.join(' ');
    if (a.includes('devcontainer.local_folder')) {
      return { stdout: 'aaaaaaaaaaaa\n', stderr: '', exitCode: 0 };
    }
    if (a.includes('com.docker.compose.project=')) {
      return {
        stdout: 'aaaaaaaaaaaa\nbbbbbbbbbbbb\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (a.startsWith('inspect --format {{index .Config.Labels')) {
      return { stdout: 'acme_devcontainer\n', stderr: '', exitCode: 0 };
    }
    return { stdout: inspectRows.join('\n'), stderr: '', exitCode: 0 };
  };
}

describe('findOomKills / formatOomKill', () => {
  const rows = [
    `aaaaaaaaaaaa${'0'.repeat(52)}\tworkspace\ttrue\trunning\t0\t${4 * 1024 ** 3}`,
    `bbbbbbbbbbbb${'0'.repeat(52)}\tpostgres\ttrue\trestarting\t7\t${512 * 1024 ** 2}`,
  ];

  it('finds the workspace and a service in a restart loop', async () => {
    expect(await findOomKills('/c/acme', oomDocker(rows))).toEqual([
      {
        container: 'workspace',
        limitBytes: 4 * 1024 ** 3,
        restarting: false,
        restarts: 0,
      },
      {
        container: 'postgres',
        limitBytes: 512 * 1024 ** 2,
        restarting: true,
        restarts: 7,
      },
    ]);
  });

  it('ignores containers that were not killed for memory', async () => {
    const quiet = rows.map((r) => r.replace('\ttrue\t', '\tfalse\t'));
    expect(await findOomKills('/c/acme', oomDocker(quiet))).toEqual([]);
  });

  it('is empty when Docker is not there', async () => {
    const broken: DockerLookupExec = () => Promise.reject(new Error('ENOENT'));
    expect(await findOomKills('/c/acme', broken)).toEqual([]);
  });

  it('names the container, its limit and the key to raise', () => {
    const at = { name: 'acme', ymlPath: ctx.ymlPath };
    expect(
      formatOomKill(
        {
          container: 'workspace',
          limitBytes: 4 * 1024 ** 3,
          restarting: false,
          restarts: 0,
        },
        at,
      ),
    ).toMatch(
      /^A process in the workspace ran out of memory at its 4 GiB memory limit and was killed\. Raise the top-level `resources\.memory` in .*acme\.yml, then run `monoceros apply acme`\.$/,
    );
    expect(
      formatOomKill(
        {
          container: 'postgres',
          limitBytes: 512 * 1024 ** 2,
          restarting: true,
          restarts: 7,
        },
        at,
      ),
    ).toMatch(
      /^postgres keeps running out of memory at its 512 MiB memory limit and is restarting \(7 restarts so far\)\. Raise `resources\.memory` of postgres/,
    );
    expect(
      formatOomKill(
        { container: 'redis', limitBytes: 0, restarting: false, restarts: 0 },
        at,
      ),
    ).toBe(
      'redis ran out of memory at the memory Docker has and was killed. Give Docker more memory, or stop workbenches you do not need.',
    );
  });

  it('explains an exit 137 in run only when the workspace was killed for memory', async () => {
    const at = { name: 'acme', ymlPath: ctx.ymlPath };
    expect(await explainExit137('/c/acme', at, oomDocker(rows))).toMatch(
      /^A process in the workspace ran out of memory/,
    );
    expect(
      await explainExit137('/c/acme', at, oomDocker([rows[1]!])),
    ).toBeUndefined();
  });
});

describe('status --json', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-limits-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    await writeFile(
      path.join(home, 'container-configs', 'acme.yml'),
      [
        'schemaVersion: 1',
        'name: acme',
        'resources:',
        '  memory: 6g',
        'services:',
        '  - name: postgres',
        '    image: postgres:18',
        '  - name: rabbitmq',
        '    image: rabbitmq:4',
        '',
      ].join('\n'),
    );
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const noContainer: DockerLookupExec = async () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
  });

  it('reports the yml figures before the first apply', async () => {
    const json = statusJson(
      await gatherStatus('acme', { home, docker: noContainer }),
    );
    expect(json).toEqual({
      name: 'acme',
      configured: true,
      enforceDefaultLimits: false,
      memoryBytes: 6 * 1024 ** 3,
      containers: [
        {
          name: 'workspace',
          memory: '6g',
          memoryBytes: 6 * 1024 ** 3,
          cpus: null,
          running: false,
          oomKilled: false,
        },
        {
          name: 'postgres',
          memory: null,
          memoryBytes: null,
          cpus: null,
          running: false,
          oomKilled: false,
        },
        {
          name: 'rabbitmq',
          memory: null,
          memoryBytes: null,
          cpus: null,
          running: false,
          oomKilled: false,
        },
      ],
    });
  });

  it('adds the catalog defaults when the machine enforces them', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.env'),
      'MONOCEROS_ENFORCE_DEFAULT_LIMITS=true\n',
    );
    const json = statusJson(
      await gatherStatus('acme', { home, docker: noContainer }),
    );
    expect(json.enforceDefaultLimits).toBe(true);
    expect(json.containers.map((c) => [c.name, c.memory, c.cpus])).toEqual([
      ['workspace', '6g', 2],
      ['postgres', '512m', 1],
      ['rabbitmq', null, null],
    ]);
    expect(json.memoryBytes).toBe(6 * 1024 ** 3 + 512 * 1024 ** 2);
  });
});
