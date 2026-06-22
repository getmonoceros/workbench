import { describe, expect, it } from 'vitest';
import {
  resolveService,
  expandCuratedService,
  curatedServiceEnvDefaults,
  deriveServiceName,
  isCuratedService,
  serviceConnectionEnv,
  serviceClientAptPackages,
  serviceClientNpmPackages,
  serviceDefersStart,
  curatedServiceExampleVolumes,
} from '../src/create/catalog.js';
import { exampleVolumesComment } from '../src/init/service-doc.js';
import { buildComposeYaml } from '../src/create/scaffold.js';
import {
  parseEnvFile,
  interpolate,
  interpolateServices,
  interpolateFeatureOptions,
  hasVarPlaceholder,
  resolveGitUserFields,
} from '../src/config/env-file.js';
import { validateConfig } from '../src/config/schema.js';
import { solutionConfigToCreateOptions } from '../src/config/transform.js';
import type { CreateOptions, ResolvedService } from '../src/create/types.js';

const base: Omit<CreateOptions, 'services'> = {
  name: 'logoscraper',
  languages: [],
};

describe('expandCuratedService / isCuratedService', () => {
  it('expands a curated name to the full catalog object with ${VAR} env placeholders', () => {
    expect(isCuratedService('postgres')).toBe(true);
    expect(expandCuratedService('postgres')).toEqual({
      name: 'postgres',
      image: 'postgres:18',
      port: 5432,
      env: {
        POSTGRES_USER: '${POSTGRES_USER}',
        POSTGRES_PASSWORD: '${POSTGRES_PASSWORD}',
        POSTGRES_DB: '${POSTGRES_DB}',
      },
      volumes: ['data:/var/lib/postgresql'],
      healthcheck: {
        test: [
          'CMD',
          'pg_isready',
          '-U',
          '${POSTGRES_USER}',
          '-d',
          '${POSTGRES_DB}',
        ],
        interval: '10s',
        timeout: '5s',
        retries: 5,
      },
      connectionEnv: {
        URL: 'postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${host}:${port}/${POSTGRES_DB}',
        HOST: '${host}',
        PORT: '${port}',
        USER: '${POSTGRES_USER}',
        PASSWORD: '${POSTGRES_PASSWORD}',
        DB: '${POSTGRES_DB}',
      },
      // No `restart:` default (issue #19) - services match the workspace's
      // no-restart-policy so the whole group stays down after a Docker restart.
    });
  });

  it('expands keycloak with a command + admin env, no volumes/healthcheck (ADR 0025)', () => {
    expect(serviceDefersStart('keycloak')).toBe(true);
    const svc = expandCuratedService('keycloak');
    expect(svc.image).toBe('quay.io/keycloak/keycloak:26.6');
    expect(svc.command).toBe('start-dev --import-realm');
    expect(svc.env).toEqual({
      KC_BOOTSTRAP_ADMIN_USERNAME: '${KC_BOOTSTRAP_ADMIN_USERNAME}',
      KC_BOOTSTRAP_ADMIN_PASSWORD: '${KC_BOOTSTRAP_ADMIN_PASSWORD}',
    });
    expect(svc.connectionEnv?.URL).toBe('http://${host}:${port}');
    expect(svc.connectionEnv?.USER).toBe('${KC_BOOTSTRAP_ADMIN_USERNAME}');
    // No persistent data dir (ephemeral H2) and no healthcheck.
    expect(svc.volumes).toBeUndefined();
    expect(svc.healthcheck).toBeUndefined();
    // `deferStart` is hidden — resolved by catalog lookup, never baked
    // into the yml service object.
    expect('deferStart' in svc).toBe(false);
    // Example bind-mounts are likewise NOT active volumes — they render as
    // a commented scaffold, so the expanded object has no `volumes`.
    expect('exampleVolumes' in svc).toBe(false);
  });

  it('exposes keycloak example volumes as a commented scaffold, not active (ADR 0025)', () => {
    const ex = curatedServiceExampleVolumes('keycloak');
    expect(ex).toEqual([
      'projects/<app>/keycloak/realm.json:/opt/keycloak/data/import/<app>.json:ro',
      'projects/<app>/keycloak/theme:/opt/keycloak/themes/<app>',
    ]);
    // ordinary services ship none
    expect(curatedServiceExampleVolumes('postgres')).toEqual([]);
    // the comment block comments the `volumes:` key itself (an active
    // empty volumes: would parse to null and apply would reject it)
    const comment = exampleVolumesComment(ex);
    expect(comment).toMatch(/^ volumes:/);
    expect(comment).toContain(
      '   - projects/<app>/keycloak/realm.json:/opt/keycloak/data/import/<app>.json:ro',
    );
    expect(exampleVolumesComment([])).toBeUndefined();
  });

  it('exposes literal env dev-defaults for .env seeding', () => {
    expect(curatedServiceEnvDefaults('postgres')).toEqual({
      POSTGRES_USER: 'monoceros',
      POSTGRES_PASSWORD: 'monoceros',
      POSTGRES_DB: 'monoceros',
    });
    // redis has no env → nothing to seed
    expect(curatedServiceEnvDefaults('redis')).toEqual({});
    // non-curated → nothing to seed
    expect(curatedServiceEnvDefaults('rustfs/rustfs:latest')).toEqual({});
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

describe('serviceDefersStart (ADR 0025)', () => {
  it('is false for an unknown / renamed service', () => {
    expect(serviceDefersStart('not-a-catalog-service')).toBe(false);
    expect(serviceDefersStart('my-renamed-keycloak')).toBe(false);
  });

  it('does not defer the ordinary infra services', () => {
    // Deferral is opt-in per descriptor; backing stores must come up with
    // the workspace so post-create (migrations/seeds) can reach them.
    for (const svc of ['postgres', 'mysql', 'mongodb', 'redis']) {
      expect(serviceDefersStart(svc)).toBe(false);
    }
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
      { location: 'services.rustfs.env.RUSTFS_ACCESS_KEY', name: 'S3_KEY' },
    ]);
  });

  it('resolves ${VAR} in feature option strings; non-strings pass through', () => {
    const out = interpolateFeatureOptions(
      [
        { ref: 'a', options: { apiKey: '${ANTHROPIC_API_KEY}' } },
        {
          ref: 'b',
          options: { rovodev: true, apiToken: '${ATLASSIAN_TOKEN}' },
        },
      ],
      { ANTHROPIC_API_KEY: 'sk-ant-xxx', ATLASSIAN_TOKEN: 'ATATT-yyy' },
    );
    expect(out[0]!.options!.apiKey).toBe('sk-ant-xxx');
    expect(out[1]!.options!.rovodev).toBe(true); // non-string passes through
    expect(out[1]!.options!.apiToken).toBe('ATATT-yyy');
  });

  it('turns a missing OR empty feature-option var into "" (→ transform skips → inherit default / unset)', () => {
    const out = interpolateFeatureOptions(
      [
        { ref: 'a', options: { apiKey: '${NOPE}' } }, // missing var
        { ref: 'b', options: { apiToken: '${BLANK}' } }, // present but empty
      ],
      { BLANK: '   ' },
    );
    expect(out[0]!.options!.apiKey).toBe('');
    expect(out[1]!.options!.apiToken).toBe('');
  });
});

describe('git identity placeholders', () => {
  it('hasVarPlaceholder detects ${VAR}, ignores plain text', () => {
    expect(hasVarPlaceholder('${GIT_USER_EMAIL}')).toBe(true);
    expect(hasVarPlaceholder('tk@conciso.de')).toBe(false);
    expect(hasVarPlaceholder('cost is $5')).toBe(false); // bare $ ignored
  });

  it('resolveGitUserFields resolves present vars', () => {
    const r = resolveGitUserFields(
      { name: '${GIT_USER_NAME}', email: '${GIT_USER_EMAIL}' },
      { GIT_USER_NAME: 'Thorsten', GIT_USER_EMAIL: 'tk@conciso.de' },
    );
    expect(r.name.value).toBe('Thorsten');
    expect(r.email.value).toBe('tk@conciso.de');
  });

  it('resolveGitUserFields yields no value for a missing var (climb cascade)', () => {
    const r = resolveGitUserFields(
      { name: '${GIT_USER_NAME}', email: '${GIT_USER_EMAIL}' },
      { GIT_USER_NAME: 'Thorsten' }, // email var absent
    );
    expect(r.name.value).toBe('Thorsten');
    expect(r.email.value).toBeUndefined();
  });

  it('resolveGitUserFields treats a seeded-but-empty var as no value (climb cascade)', () => {
    const r = resolveGitUserFields(
      { name: '${GIT_USER_NAME}', email: '${GIT_USER_EMAIL}' },
      { GIT_USER_NAME: '', GIT_USER_EMAIL: '   ' }, // present but blank
    );
    expect(r.name.value).toBeUndefined();
    expect(r.email.value).toBeUndefined();
  });

  it('resolveGitUserFields passes literal values through (trimmed)', () => {
    const r = resolveGitUserFields(
      { name: 'Plain Name', email: 'plain@example.com' },
      {},
    );
    expect(r.name.value).toBe('Plain Name');
    expect(r.email.value).toBe('plain@example.com');
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

  it('defaults a service with no explicit restart to unless-stopped (issue #22)', () => {
    const yaml = buildComposeYaml({
      ...base,
      services: [{ name: 'redis', image: 'redis:7', env: {}, volumes: [] }],
    });
    // Workspace + redis both carry the default, so the group comes back
    // together: two `restart: unless-stopped` lines.
    expect(yaml.match(/restart: unless-stopped/g)).toHaveLength(2);
  });

  it('honors an explicit per-service restart over the default (issue #22)', () => {
    const yaml = buildComposeYaml({
      ...base,
      services: [
        {
          name: 'redis',
          image: 'redis:7',
          env: {},
          volumes: [],
          restart: 'no',
        },
      ],
    });
    // redis opts out with `no`; the workspace keeps the default (one match).
    expect(yaml).toContain('    restart: no');
    expect(yaml.match(/restart: unless-stopped/g)).toHaveLength(1);
  });

  it('emits `user:` for a service that sets it, omits it otherwise', () => {
    const withUser = buildComposeYaml({
      ...base,
      services: [
        {
          name: 'rustfs',
          image: 'rustfs/rustfs:latest',
          user: '0:0',
          env: {},
          volumes: [],
        },
      ],
    });
    // Lets a fixed-non-root-uid image write its bind-mounted data dir on
    // native Linux (rustfs would otherwise exit FATAL "Read-only file
    // system"). composeScalar double-quotes the value.
    expect(withUser).toContain('    user: "0:0"');

    const noUser = buildComposeYaml({
      ...base,
      services: [{ name: 'redis', image: 'redis:7', env: {}, volumes: [] }],
    });
    expect(noUser).not.toMatch(/^\s*user:/m);
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

describe('serviceConnectionEnv', () => {
  const pgConn = {
    URL: 'postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${host}:${port}/${POSTGRES_DB}',
    HOST: '${host}',
    PORT: '${port}',
    USER: '${POSTGRES_USER}',
    PASSWORD: '${POSTGRES_PASSWORD}',
    DB: '${POSTGRES_DB}',
  };
  const pg: ResolvedService = {
    name: 'postgres',
    image: 'postgres:18',
    port: 5432,
    env: {
      POSTGRES_USER: 'monoceros',
      POSTGRES_PASSWORD: 'monoceros',
      POSTGRES_DB: 'monoceros',
    },
    volumes: [],
    connectionEnv: pgConn,
  };
  const redis: ResolvedService = {
    name: 'redis',
    image: 'redis:7',
    port: 6379,
    env: {},
    volumes: [],
    connectionEnv: {
      URL: 'redis://${host}:${port}',
      HOST: '${host}',
      PORT: '${port}',
    },
  };
  const mysql: ResolvedService = {
    name: 'mysql',
    image: 'mysql:8',
    port: 3306,
    env: { MYSQL_ROOT_PASSWORD: 'monoceros', MYSQL_DATABASE: 'monoceros' },
    volumes: [],
    connectionEnv: {
      URL: 'mysql://root:${MYSQL_ROOT_PASSWORD}@${host}:${port}/${MYSQL_DATABASE}',
      HOST: '${host}',
      PORT: '${port}',
      USER: 'root',
      PASSWORD: '${MYSQL_ROOT_PASSWORD}',
      DB: '${MYSQL_DATABASE}',
    },
  };
  // A genuinely non-catalog service (clickhouse isn't curated) — no catalog
  // connectionEnv to fall back to.
  const custom: ResolvedService = {
    name: 'clickhouse',
    image: 'clickhouse/clickhouse-server:latest',
    port: 8123,
    env: {},
    volumes: [],
  };

  it('derives POSTGRES_* (name-prefixed) for postgres', () => {
    expect(serviceConnectionEnv([pg])).toEqual({
      POSTGRES_URL: 'postgresql://monoceros:monoceros@postgres:5432/monoceros',
      POSTGRES_HOST: 'postgres',
      POSTGRES_PORT: '5432',
      POSTGRES_USER: 'monoceros',
      POSTGRES_PASSWORD: 'monoceros',
      POSTGRES_DB: 'monoceros',
    });
  });

  it('derives REDIS_* for redis', () => {
    expect(serviceConnectionEnv([redis])).toEqual({
      REDIS_URL: 'redis://redis:6379',
      REDIS_HOST: 'redis',
      REDIS_PORT: '6379',
    });
  });

  it('skips services without a connectionEnv (custom images)', () => {
    expect(serviceConnectionEnv([custom])).toEqual({});
  });

  it('multiple databases coexist without collision (no bare DATABASE_URL)', () => {
    const env = serviceConnectionEnv([mysql, pg]);
    expect(env.POSTGRES_URL).toBe(
      'postgresql://monoceros:monoceros@postgres:5432/monoceros',
    );
    expect(env.MYSQL_URL).toBe('mysql://root:monoceros@mysql:3306/monoceros');
    // No bare DATABASE_URL / PGHOST to clobber.
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.PGHOST).toBeUndefined();
  });

  it('looks up the catalog by name when the service has no connectionEnv (real yml path)', () => {
    // The yml serializer does NOT write a connectionEnv block, so a parsed
    // curated service has none — serviceConnectionEnv must fall back to the
    // catalog by name. (Regression: reading only svc.connectionEnv yielded an
    // empty workspace env.)
    const fromYml: ResolvedService = {
      name: 'postgres',
      image: 'postgres:18',
      port: 5432,
      env: {
        POSTGRES_USER: 'monoceros',
        POSTGRES_PASSWORD: 'monoceros',
        POSTGRES_DB: 'monoceros',
      },
      volumes: [],
    };
    expect(fromYml.connectionEnv).toBeUndefined();
    const env = serviceConnectionEnv([fromYml]);
    expect(env.POSTGRES_URL).toBe(
      'postgresql://monoceros:monoceros@postgres:5432/monoceros',
    );
    expect(env.POSTGRES_HOST).toBe('postgres');
  });

  it('a renamed instance with no connectionEnv gets none (function contract)', () => {
    // Function contract in isolation: catalog lookup is by name, and a custom
    // name (`analytics`) is not a catalog id, so an object with no block yields
    // nothing. In the real pipeline this case does not occur — the serializer
    // (renderServiceObjectBody) always writes the block, so a parsed renamed
    // instance carries its templates (see modify-yml.test.ts `--as`).
    const analytics: ResolvedService = {
      name: 'analytics',
      image: 'postgres:18',
      port: 5432,
      env: {},
      volumes: [],
    };
    expect(serviceConnectionEnv([analytics])).toEqual({});
  });

  it('an explicit connectionEnv on the service is honoured and travels with a rename', () => {
    const analytics: ResolvedService = { ...pg, name: 'analytics' };
    const env = serviceConnectionEnv([analytics]);
    expect(env.ANALYTICS_URL).toBe(
      'postgresql://monoceros:monoceros@analytics:5432/monoceros',
    );
    expect(env.POSTGRES_URL).toBeUndefined();
  });

  it('two instances of the same engine do not collide', () => {
    const analytics: ResolvedService = { ...pg, name: 'analytics' };
    const env = serviceConnectionEnv([pg, analytics]);
    expect(env.POSTGRES_URL).toContain('@postgres:5432/');
    expect(env.ANALYTICS_URL).toContain('@analytics:5432/');
  });

  it('curates the new service wave with connection URLs', () => {
    for (const name of ['pgvector', 'mongodb', 'rustfs', 'mailpit']) {
      expect(isCuratedService(name)).toBe(true);
      expect(expandCuratedService(name).connectionEnv?.URL).toBeTruthy();
    }
  });

  it('pgvector emits PGVECTOR_* and coexists with a postgres', () => {
    const pgv = resolveService(expandCuratedService('pgvector'));
    const env = serviceConnectionEnv([
      pg,
      {
        ...pgv,
        env: {
          POSTGRES_USER: 'monoceros',
          POSTGRES_PASSWORD: 'monoceros',
          POSTGRES_DB: 'monoceros',
        },
      },
    ]);
    expect(env.PGVECTOR_URL).toBe(
      'postgresql://monoceros:monoceros@pgvector:5432/monoceros',
    );
    expect(env.POSTGRES_URL).toContain('@postgres:5432/');
  });

  it('contributes CLI client apt packages for curated services (deduped)', () => {
    const svcs = ['postgres', 'mysql', 'redis', 'pgvector', 'rustfs'].map((n) =>
      resolveService(expandCuratedService(n)),
    );
    // postgres + pgvector both → postgresql-client (deduped); rustfs → awscli.
    expect(serviceClientAptPackages(svcs)).toEqual([
      'awscli',
      'default-mysql-client',
      'postgresql-client',
      'redis-tools',
    ]);
  });

  it('no apt client for mongodb/mailpit (mongodb ships an npm client)', () => {
    const svcs = ['mongodb', 'mailpit'].map((n) =>
      resolveService(expandCuratedService(n)),
    );
    expect(serviceClientAptPackages(svcs)).toEqual([]);
  });

  it('contributes npm client tools (mongodb → mongosh; apt-only services none)', () => {
    const mongo = resolveService(expandCuratedService('mongodb'));
    expect(serviceClientNpmPackages([mongo])).toEqual(['mongosh']);
    // postgres/redis use apt clients, not npm.
    const pgRedis = ['postgres', 'redis'].map((n) =>
      resolveService(expandCuratedService(n)),
    );
    expect(serviceClientNpmPackages(pgRedis)).toEqual([]);
  });

  it('rustfs runs as root so it can write its bind-mounted /data', () => {
    // rustfs runs as a fixed non-root uid and exits if it can't write the
    // apply-created host data dir on native Linux. Catalog pins user 0:0.
    expect(expandCuratedService('rustfs').user).toBe('0:0');
  });

  it('rustfs emits S3 endpoint + keys (RUSTFS_*)', () => {
    const rustfs = resolveService(expandCuratedService('rustfs'));
    const env = serviceConnectionEnv([
      {
        ...rustfs,
        env: { RUSTFS_ACCESS_KEY: 'ak', RUSTFS_SECRET_KEY: 'sk' },
      },
    ]);
    expect(env.RUSTFS_URL).toBe('http://rustfs:9000');
    expect(env.RUSTFS_ACCESS_KEY).toBe('ak');
    expect(env.RUSTFS_SECRET_KEY).toBe('sk');
  });
});

describe('buildComposeYaml — workspace service connection env', () => {
  it('injects the curated-service connection env onto the workspace service', () => {
    const services: ResolvedService[] = [
      {
        name: 'postgres',
        image: 'postgres:18',
        port: 5432,
        env: {
          POSTGRES_USER: 'monoceros',
          POSTGRES_PASSWORD: 'monoceros',
          POSTGRES_DB: 'monoceros',
        },
        volumes: [],
        connectionEnv: {
          URL: 'postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${host}:${port}/${POSTGRES_DB}',
          HOST: '${host}',
        },
      },
    ];
    const yaml = buildComposeYaml({ ...base, services });
    expect(yaml).toContain(
      '      POSTGRES_URL: "postgresql://monoceros:monoceros@postgres:5432/monoceros"',
    );
    expect(yaml).toContain('      POSTGRES_HOST: "postgres"');
  });
});
