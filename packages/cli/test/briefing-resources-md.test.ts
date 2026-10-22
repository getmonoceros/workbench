import { describe, expect, it } from 'vitest';
import {
  agentsMdInputFromCreateOptions,
  generateAgentsMd,
} from '../src/briefing/agents-md.js';
import { generateResourcesMd } from '../src/briefing/resources-md.js';

/**
 * The agent is the one whose build hits a limit, and it only sees `Killed`
 * or exit 137 (ADR 0062). The briefing has to give it the figures, the
 * reason, where the user sets them, and what to do.
 */
describe('.monoceros/resources.md generator', () => {
  const limits = [
    { name: 'workspace', memory: '4g', cpus: 2 },
    { name: 'postgres', memory: '512m', cpus: 1 },
    { name: 'redis' },
  ];

  it('names the limits of this workbench', () => {
    const md = generateResourcesMd({ containerName: 'demo', limits });
    expect(md).toContain('# Memory and CPU limits');
    expect(md).toContain('workspace 4g, 2 CPUs · postgres 512m, 1 CPU.');
    expect(md).not.toContain('redis');
  });

  it('says so when nothing is limited', () => {
    const md = generateResourcesMd({ containerName: 'demo', limits: [] });
    expect(md).toContain('None. Every container of this workbench runs');
  });

  it('explains why, where they are set and how a kill looks from inside', () => {
    const md = generateResourcesMd({ containerName: 'demo', limits });
    expect(md).toContain('shared with every other\nworkbench that is up');
    expect(md).toContain('`container-configs/demo.yml`');
    expect(md).toContain('MONOCEROS_ENFORCE_DEFAULT_LIMITS');
    expect(md).toContain('`monoceros apply demo` on the host');
    // There is no command for it; an agent must not invent one.
    expect(md).toContain('No `monoceros` command sets a limit.');
    expect(md).toContain('`cat /sys/fs/cgroup/memory.events`');
    expect(md).toContain('`monoceros status demo`');
    // `nproc` ignores the cpus quota, which is how worker pools get oversized.
    expect(md).toContain('`nproc`');
  });

  it('asks for double the current workspace memory in its example', () => {
    expect(generateResourcesMd({ containerName: 'demo', limits })).toContain(
      '  memory: 8g',
    );
    expect(
      generateResourcesMd({
        containerName: 'demo',
        limits: [{ name: 'workspace', memory: '512m' }],
      }),
    ).toContain('  memory: 1024m');
  });
});

describe('AGENTS.md: limits', () => {
  const base = {
    containerName: 'demo',
    languages: [],
    services: [],
    features: [],
    repos: [],
    ports: [],
  };

  it('carries the 137 rule and imports the chapter, with or without limits', () => {
    const md = generateAgentsMd(base);
    expect(md).toContain(
      '- A build or test that dies with `Killed` or exit code 137 ran out of',
    );
    expect(md).toContain('@.monoceros/resources.md');
    expect(md).not.toContain('### Memory and CPU limits');
  });

  it('lists the figures in the inventory when a container has a limit', () => {
    const md = generateAgentsMd({
      ...base,
      limits: [
        { name: 'workspace', memory: '3g' },
        { name: 'postgres', memory: '512m', cpus: 1 },
        { name: 'redis' },
      ],
    });
    expect(md).toContain('### Memory and CPU limits');
    expect(md).toContain('- `workspace` (this container): 3g');
    expect(md).toContain('- `postgres`: 512m, 1 CPU');
    expect(md).not.toContain('- `redis`');
  });

  it('takes the effective limits from the create options', () => {
    const input = agentsMdInputFromCreateOptions(
      {
        name: 'demo',
        languages: [],
        resources: { memory: '3g', cpus: 2 },
        services: [
          {
            name: 'postgres',
            image: 'postgres:18',
            env: {},
            volumes: [],
            resources: { memory: '512m' },
          },
        ],
      },
      new Map(),
    );
    expect(input.limits).toEqual([
      { name: 'workspace', memory: '3g', cpus: 2 },
      { name: 'postgres', memory: '512m' },
    ]);
  });
});
