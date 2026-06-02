import { describe, expect, it } from 'vitest';
import {
  resolveService,
  expandCuratedService,
  deriveServiceName,
  isCuratedService,
} from '../src/create/catalog.js';
import { buildComposeYaml } from '../src/create/scaffold.js';
import {
  parseEnvFile,
  interpolate,
  interpolateServices,
} from '../src/config/env-file.js';
import { validateConfig } from '../src/config/schema.js';
import { solutionConfigToCreateOptions } from '../src/config/transform.js';
import type { CreateOptions, ResolvedService } from '../src/create/types.js';

const base: Omit<CreateOptions, 'services'> = {
  name: 'logoscraper',
  languages: [],
};

describe('expandCuratedService / isCuratedService', () => {
  it('expands a curated name to the full catalog object', () => {
    expect(isCuratedService('postgres')).toBe(true);
    expect(expandCuratedService('postgres')).toEqual({
      name: 'postgres',
      image: 'postgres:18',
      port: 5432,
      env: {
        POSTGRES_USER: 'monoceros',
        POSTGRES_PASSWORD: 'monoceros',
        POSTGRES_DB: 'monoceros',
      },
      volumes: ['data:/var/lib/postgresql'],
    });
  });

  it('reports non-catalog names as not curated and refuses to expand them', () => {
    expect(isCuratedService('rustfs/rustfs:latest')).toBe(false);
    expect(() => expandCuratedService('rustfs/rustfs:latest')).toThrow(
      /Unknown service/,
    );
  });
});

describe('deriveServiceName', () => {
  it('takes the image leaf, strips tag/registry, sanitises', () => {
    expect(deriveServiceName('rustfs/rustfs:latest')).toBe('rustfs');
    expect(deriveServiceName('postgres:16-alpine')).toBe('postgres');
    expect(deriveServiceName('ghcr.io/foo/Bar:1')).toBe('bar');
    expect(deriveServiceName('ghcr.io:5000/x/app')).toBe('app');
  });
});

describe('resolveService', () => {
  it('normalizes an object, defaulting env/volumes to empty', () => {
    expect(
      resolveService({
        name: 'rustfs',
        image: 'rustfs/rustfs:latest',
        port: 9000,
        env: { RUSTFS_ACCESS_KEY: '${S3_ACCESS_KEY}' },
      }),
    ).toEqual({
      name: 'rustfs',
      image: 'rustfs/rustfs:latest',
      port: 9000,
      env: { RUSTFS_ACCESS_KEY: '${S3_ACCESS_KEY}' },
      volumes: [],
    });
  });
});

describe('env-file parsing + interpolation', () => {
  it('parses KEY=VALUE, skips comments/blanks, strips quotes, honors export', () => {
    const parsed = parseEnvFile(
      [
        '# a comment',
        '',
        'PG_DB=logoscraper',
        'export PG_USER=app',
        'PG_PASSWORD="s3cr#et: value"',
        "S3_ACCESS_KEY='quoted'",
        'not a valid line',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      PG_DB: 'logoscraper',
      PG_USER: 'app',
      PG_PASSWORD: 's3cr#et: value',
      S3_ACCESS_KEY: 'quoted',
    });
  });

  it('substitutes ${VAR} and reports missing names', () => {
    const ok = interpolate('${A}-x', { A: '1' });
    expect(ok).toEqual({ value: '1-x', missing: [] });

    const bad = interpolate('${A}-${B}', { A: '1' });
    expect(bad.value).toBe('1-${B}'); // missing left visible
    expect(bad.missing).toEqual(['B']);
  });

  it('leaves a bare $VAR (no braces) untouched', () => {
    expect(interpolate('cost is $5', {}).missing).toEqual([]);
  });

  it('interpolates service env + command and aggregates every missing var', () => {
    const services: ResolvedService[] = [
      {
        name: 'postgres',
        image: 'postgres:16-alpine',
        env: { POSTGRES_PASSWORD: '${PG_PASSWORD}', POSTGRES_DB: 'fixed' },
        volumes: [],
      },
      {
        name: 'rustfs',
        image: 'rustfs/rustfs:latest',
        env: { RUSTFS_ACCESS_KEY: '${S3_KEY}' },
        volumes: [],
      },
    ];
    const result = interpolateServices(services, { PG_PASSWORD: 'hunter2' });
    expect(result.services[0]!.env.POSTGRES_PASSWORD).toBe('hunter2');
    expect(result.missing).toEqual([
      { service: 'rustfs', field: 'env.RUSTFS_ACCESS_KEY', name: 'S3_KEY' },
    ]);
  });
});

describe('buildComposeYaml — generic service objects', () => {
  it('emits image, env (quoted), data + host-relative volumes, healthcheck, restart', () => {
    const services: ResolvedService[] = [
      {
        name: 'postgres',
        image: 'postgres:16-alpine',
        port: 5432,
        env: { POSTGRES_DB: 'logoscraper', POSTGRES_PASSWORD: 'p@ss: word' },
        volumes: [
          'data:/var/lib/postgresql/data',
          'projects/logoscraper/init.sql:/docker-entrypoint-initdb.d/init.sql:ro',
        ],
        healthcheck: { test: 'pg_isready -U app', interval: '10s', retries: 5 },
        restart: 'unless-stopped',
      },
    ];
    const yaml = buildComposeYaml({ ...base, services });

    expect(yaml).toContain('  postgres:');
    expect(yaml).toContain('    image: postgres:16-alpine');
    expect(yaml).toContain('    restart: unless-stopped');
    // env values are always double-quoted so special chars survive
    expect(yaml).toContain('      POSTGRES_DB: "logoscraper"');
    expect(yaml).toContain('      POSTGRES_PASSWORD: "p@ss: word"');
    // data: shorthand → per-service host data dir; host path → ../<path>
    expect(yaml).toContain('      - ../data/postgres:/var/lib/postgresql/data');
    expect(yaml).toContain(
      '      - ../projects/logoscraper/init.sql:/docker-entrypoint-initdb.d/init.sql:ro',
    );
    expect(yaml).toContain('    healthcheck:');
    expect(yaml).toContain('      test: "pg_isready -U app"');
    expect(yaml).toContain('      interval: 10s');
    expect(yaml).toContain('      retries: 5');
    // the internal port is NOT a compose host mapping
    expect(yaml).not.toMatch(/ports:/);
  });

  it('renders a healthcheck exec-array as a compose flow sequence', () => {
    const services: ResolvedService[] = [
      {
        name: 'postgres',
        image: 'postgres:18',
        env: {},
        volumes: [],
        healthcheck: {
          test: ['CMD', 'pg_isready', '-U', 'app'],
          interval: '10s',
          retries: 5,
        },
      },
    ];
    const yaml = buildComposeYaml({ ...base, services });
    expect(yaml).toContain('      test: ["CMD", "pg_isready", "-U", "app"]');
  });

  it('strips a leading ./ from a host volume source', () => {
    const services: ResolvedService[] = [
      {
        name: 'pg',
        image: 'postgres:18',
        env: {},
        volumes: [
          './projects/app/init.sql:/docker-entrypoint-initdb.d/x.sql:ro',
        ],
      },
    ];
    const yaml = buildComposeYaml({ ...base, services });
    expect(yaml).toContain(
      '      - ../projects/app/init.sql:/docker-entrypoint-initdb.d/x.sql:ro',
    );
  });

  it('rejects a docker named volume but accepts data: and ./ paths', () => {
    const make = (vol: string) =>
      validateConfig({
        schemaVersion: 1,
        name: 'demo',
        services: [{ name: 'svc', image: 'x:1', volumes: [vol] }],
      });
    expect(() => make('rustfs_data:/data')).toThrow(/Invalid volume/);
    expect(() => make('data:/data')).not.toThrow();
    expect(() => make('./config:/etc/app')).not.toThrow();
    expect(() => make('projects/app/init.sql:/x.sql:ro')).not.toThrow();
  });

  it('interpolates ${VAR} in healthcheck + image, not just env', () => {
    const services: ResolvedService[] = [
      {
        name: 'pg',
        image: 'postgres:${PG_TAG}',
        env: { POSTGRES_USER: '${PG_USER}' },
        volumes: [],
        healthcheck: { test: ['CMD', 'pg_isready', '-U', '${PG_USER}'] },
      },
    ];
    const { services: out, missing } = interpolateServices(services, {
      PG_TAG: '16-alpine',
      PG_USER: 'app',
    });
    expect(missing).toEqual([]);
    expect(out[0]!.image).toBe('postgres:16-alpine');
    expect(out[0]!.healthcheck!.test).toEqual([
      'CMD',
      'pg_isready',
      '-U',
      'app',
    ]);
  });

  it('round-trips the logoscraper-shaped yml through schema → options → compose', () => {
    const config = validateConfig({
      schemaVersion: 1,
      name: 'logoscraper',
      services: [
        {
          name: 'postgres',
          image: 'postgres:16-alpine',
          env: { POSTGRES_DB: 'logoscraper' },
          volumes: ['data:/var/lib/postgresql/data'],
        },
        {
          name: 'rustfs',
          image: 'rustfs/rustfs:latest',
          port: 9000,
          env: { RUSTFS_ACCESS_KEY: 'static-key' },
        },
      ],
    });
    const opts = solutionConfigToCreateOptions(config);
    expect(opts.services.map((s) => s.name)).toEqual(['postgres', 'rustfs']);
    const yaml = buildComposeYaml(opts);
    expect(yaml).toContain('  postgres:');
    expect(yaml).toContain('  rustfs:');
    expect(yaml).toContain('    image: rustfs/rustfs:latest');
  });
});
