import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  renderCheckReport,
  runCheck,
  type CheckOptions,
  type CheckRule,
  type Finding,
} from '../src/check/index.js';
import { colorsFor } from '../src/util/format.js';

const NAME = 'acme';

let home: string;

const containerRoot = (): string => path.join(home, 'container', NAME);

async function writeYml(body: string): Promise<void> {
  const dir = path.join(home, 'container-configs');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${NAME}.yml`), body);
}

async function file(rel: string, body: string): Promise<void> {
  const full = path.join(containerRoot(), rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body);
}

async function workspace(folders: { path: string; name?: string }[]) {
  await file(`${NAME}.code-workspace`, JSON.stringify({ folders }, null, 2));
}

/**
 * Every runCheck call goes through this so the proxy-network rule (#74)
 * never reaches the host docker daemon: the lookup reports "nothing
 * running", which is the rule's silent branch. Tests that DO exercise the
 * rule pass their own stubs.
 */
function checkOpts(extra: Partial<CheckOptions> = {}): CheckOptions {
  return {
    home,
    containerLookupDocker: async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }),
    ...extra,
  };
}

/** A briefing file the way apply writes it: body inside the marker pair. */
async function briefing(name: string, body: string): Promise<void> {
  await file(
    name,
    `<!-- monoceros:begin -->\n\n${body}\n<!-- monoceros:end -->\n`,
  );
}

/** A minimal materialized container: yml + workspace file + projects/. */
async function scaffold(
  yml = 'schemaVersion: 1\nname: acme\nlanguages:\n  - node\n',
): Promise<void> {
  await writeYml(yml);
  await mkdir(path.join(containerRoot(), 'projects'), { recursive: true });
  await workspace([{ path: '.', name: 'workspace' }]);
}

const rulesOf = (findings: readonly Finding[]): CheckRule[] =>
  findings.map((f) => f.rule);

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'monoceros-check-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('runCheck', () => {
  it('errors when the container is not materialized', async () => {
    await writeYml('schemaVersion: 1\nname: acme\n');
    await expect(runCheck(NAME, checkOpts())).rejects.toThrow(
      /No materialized container/,
    );
  });

  it('reports nothing for a clean container and says what it looked at', async () => {
    await scaffold();
    await file('projects/web/package.json', '{"name":"web"}');
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/web', name: 'web' },
    ]);

    const report = await runCheck(NAME, checkOpts());
    expect(report.findings).toEqual([]);
    expect(report.scanned).toEqual({
      projects: 1,
      composeFiles: 0,
      apps: 0,
    });
  });

  it('flags a project directory that is missing from the workspace file', async () => {
    await scaffold();
    await mkdir(path.join(containerRoot(), 'projects', 'shop'), {
      recursive: true,
    });

    const report = await runCheck(NAME, checkOpts());
    expect(rulesOf(report.findings)).toEqual(['workspace-registration']);
    const finding = report.findings[0]!;
    expect(finding.where).toBe('projects/shop');
    expect(finding.what).toContain('acme.code-workspace');
    expect(finding.fix).toContain(
      '{ "path": "projects/shop", "name": "shop" }',
    );
  });

  it('flags project files at the workspace root and leaves Monoceros entries alone', async () => {
    await scaffold();
    await briefing('AGENTS.md', '# briefing\n');
    await briefing('CLAUDE.md', '@AGENTS.md\n');
    await file('.monoceros/commands.md', '# commands\n');
    await file('package.json', '{"name":"oops"}');
    await mkdir(path.join(containerRoot(), 'src'), { recursive: true });

    const report = await runCheck(NAME, checkOpts());
    expect(rulesOf(report.findings)).toEqual([
      'workspace-root',
      'workspace-root',
    ]);
    expect(report.findings.map((f) => f.where)).toEqual([
      'package.json',
      'src',
    ]);
  });

  it('leaves the pnpm store at the root alone', async () => {
    // pnpm puts its store on the project's filesystem, which in a dev
    // container is the workspace mount, not $HOME. It shows up in every
    // Node workbench and is nobody's mistake.
    await scaffold();
    await mkdir(path.join(containerRoot(), '.pnpm-store'), { recursive: true });

    const report = await runCheck(NAME, checkOpts());
    expect(report.findings).toEqual([]);
  });

  it('keeps the project’s own variable name and asks only for the `:?`', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nservices:\n  - name: postgres\n    image: postgres:18\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/api', name: 'api' },
    ]);
    await file(
      'projects/api/compose.yaml',
      [
        'services:',
        '  postgres:',
        '    image: postgres:18',
        '    environment:',
        '      POSTGRES_USER: ${PG_USER}',
        '      POSTGRES_PASSWORD: ${PG_PASSWORD:?set it as a pipeline secret}',
        '      POSTGRES_DB: ${PG_DB:?set it as a pipeline secret}',
        '    healthcheck:',
        '      test: [CMD, pg_isready]',
        '',
      ].join('\n'),
    );

    const report = await runCheck(NAME, checkOpts());
    const drift = report.findings.filter((f) => f.rule === 'compose-drift');
    // `${PG_PASSWORD:?…}` and `${PG_DB:?…}` fail fast under their own
    // names, so nothing to report there. Only the missing `:?` is left.
    expect(drift).toHaveLength(1);
    expect(drift[0]!.what).toContain('`POSTGRES_USER` reads `${PG_USER}`');
    expect(drift[0]!.fix).toContain('POSTGRES_USER: ${PG_USER:?…}');
    expect(drift[0]!.fix).toContain('your own variable name is fine');
  });

  it('treats a service volume source directory at the root as owned', async () => {
    // A yml-declared bind source is legitimate even at the root.
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nservices:\n  - name: keycloak\n    image: quay.io/keycloak/keycloak:26.6\n    volumes:\n      - seed/realm.json:/opt/keycloak/data/import/acme.json:ro\n',
    );
    await file('seed/realm.json', '{}');

    const report = await runCheck(NAME, checkOpts());
    expect(report.findings).toEqual([]);
  });

  it('flags compose drift against the catalog block: image, healthcheck, required vars', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nservices:\n  - name: postgres\n    image: postgres:18\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/api', name: 'api' },
    ]);
    await file(
      'projects/api/compose.yaml',
      [
        'services:',
        '  postgres:',
        '    image: postgres:15',
        '    environment:',
        '      POSTGRES_USER: app',
        '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-secret}',
        '',
      ].join('\n'),
    );

    const report = await runCheck(NAME, checkOpts());
    expect(report.scanned.composeFiles).toBe(1);
    const drift = report.findings.filter((f) => f.rule === 'compose-drift');
    const what = drift.map((f) => f.what).join('\n');
    // Wrong tag: the container runs postgres:18, so deploy.md printed that.
    expect(what).toContain('image is `postgres:15`');
    expect(what).toContain('postgres:18');
    // Missing healthcheck.
    expect(what).toContain('No healthcheck');
    // A literal value ships a credential in the repo.
    expect(what).toContain('`POSTGRES_USER` is the literal `app`');
    // A default is a variable without `:?` — the name is not the problem.
    expect(what).toContain(
      '`POSTGRES_PASSWORD` reads `${POSTGRES_PASSWORD:-secret}`, which has no `:?`',
    );
    // And the variable the file does not set at all.
    expect(what).toContain('Does not set `POSTGRES_DB`');
    for (const f of drift) {
      expect(f.where).toBe('projects/api/compose.yaml → services.postgres');
    }
  });

  it('accepts a compose block copied verbatim from the catalog', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nservices:\n  - name: postgres\n    image: postgres:18\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/api', name: 'api' },
    ]);
    await file(
      'projects/api/compose.yaml',
      [
        'services:',
        '  postgres:',
        '    image: postgres:18',
        '    environment:',
        '      POSTGRES_USER: ${POSTGRES_USER:?set it as a pipeline secret}',
        '      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set it as a pipeline secret}',
        '      POSTGRES_DB: ${POSTGRES_DB:?set it as a pipeline secret}',
        '    healthcheck:',
        '      test: [CMD, pg_isready]',
        '',
      ].join('\n'),
    );

    const report = await runCheck(NAME, checkOpts());
    expect(report.findings.filter((f) => f.rule === 'compose-drift')).toEqual(
      [],
    );
  });

  it('ignores compose services that are not catalog services', async () => {
    await scaffold();
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/api', name: 'api' },
    ]);
    await file(
      'projects/api/compose.yaml',
      'services:\n  api:\n    image: acme/api:1\n  db:\n    image: postgres:15\n',
    );

    const report = await runCheck(NAME, checkOpts());
    expect(report.findings.filter((f) => f.rule === 'compose-drift')).toEqual(
      [],
    );
  });

  it('flags a launch target on an unexposed port and one pinned to loopback', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nrouting:\n  ports:\n    - 3000\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/web', name: 'web' },
    ]);
    await file(
      'projects/web/.monoceros/launch.json',
      JSON.stringify({
        targets: [
          { name: 'web', command: 'npm run dev -- --host 0.0.0.0', port: 3000 },
          { name: 'admin', command: 'npm run admin', port: 4200 },
          {
            name: 'api',
            command: 'npm run api -- --host 127.0.0.1',
            port: 3000,
          },
        ],
      }),
    );

    const report = await runCheck(NAME, checkOpts());
    const launch = report.findings.filter((f) => f.rule === 'launch-config');
    expect(launch.map((f) => f.where)).toEqual([
      'projects/web/.monoceros/launch.json → admin',
      'projects/web/.monoceros/launch.json → api',
    ]);
    expect(launch[0]!.what).toContain('Port 4200 is not exposed');
    expect(launch[0]!.fix).toContain('monoceros add-port acme 4200');
    expect(launch[1]!.what).toContain('--host 127.0.0.1');
  });

  it('flags a readyTimeout the pinned runtime is too old to honour', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nruntimeVersion: 1.6.1\nlanguages:\n  - go\nrouting:\n  ports:\n    - 7777\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/api', name: 'api' },
    ]);
    await file(
      'projects/api/.monoceros/launch.json',
      JSON.stringify({
        targets: [
          { name: 'api', command: './dev.sh', port: 7777, readyTimeout: 120 },
          { name: 'worker', command: './worker.sh', port: 7777 },
        ],
      }),
    );

    const report = await runCheck(NAME, checkOpts());
    const launch = report.findings.filter((f) => f.rule === 'launch-config');
    expect(launch.map((f) => f.where)).toEqual([
      'projects/api/.monoceros/launch.json → api',
    ]);
    expect(launch[0]!.what).toContain('ignored by runtime 1.6.1');
    expect(launch[0]!.fix).toContain('monoceros upgrade acme');
  });

  it('leaves readyTimeout alone on a runtime that honours it', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nruntimeVersion: 1.6.2\nlanguages:\n  - go\nrouting:\n  ports:\n    - 7777\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/api', name: 'api' },
    ]);
    await file(
      'projects/api/.monoceros/launch.json',
      JSON.stringify({
        targets: [
          { name: 'api', command: './dev.sh', port: 7777, readyTimeout: 120 },
        ],
      }),
    );

    const report = await runCheck(NAME, checkOpts());
    expect(report.findings.filter((f) => f.rule === 'launch-config')).toEqual(
      [],
    );
  });

  it('flags a project that serves something but declares no launch config', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nrouting:\n  ports:\n    - 3000\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/web', name: 'web' },
      { path: 'projects/lib', name: 'lib' },
    ]);
    await file(
      'projects/web/package.json',
      JSON.stringify({ scripts: { dev: 'vite' } }),
    );
    // A library: a `build` script only, so it must not be flagged.
    await file(
      'projects/lib/package.json',
      JSON.stringify({ scripts: { build: 'tsc' } }),
    );

    const report = await runCheck(NAME, checkOpts());
    const launch = report.findings.filter((f) => f.rule === 'launch-config');
    expect(launch).toHaveLength(1);
    expect(launch[0]!.where).toBe('projects/web/package.json');
    expect(launch[0]!.what).toContain('`dev` script');
    expect(launch[0]!.fix).toContain('projects/web/.monoceros/launch.json');
  });

  it('flags a package script the project does not define, and a cwd that is not there', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nrouting:\n  ports:\n    - 3000\n    - 5173\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/web', name: 'web' },
    ]);
    await file(
      'projects/web/package.json',
      JSON.stringify({ scripts: { start: 'vite', build: 'vite build' } }),
    );
    await file(
      'projects/web/.monoceros/launch.json',
      JSON.stringify({
        targets: [
          // `dev` does not exist here; the package calls it `start`.
          { name: 'web', command: 'npm run dev', port: 3000 },
          { name: 'ghost', command: 'npm run serve', port: 5173, cwd: 'ui' },
        ],
      }),
    );

    const report = await runCheck(NAME, checkOpts());
    const launch = report.findings.filter((f) => f.rule === 'launch-config');
    expect(launch).toHaveLength(2);
    expect(launch[0]!.what).toContain(
      'Runs the `dev` script, which projects/web/package.json does not define',
    );
    // The fix names what the package actually offers.
    expect(launch[0]!.fix).toContain('start, build');
    // A missing cwd is reported on its own, and stops there: looking for a
    // package.json underneath it would only add noise.
    expect(launch[1]!.what).toContain('`cwd: ui` does not exist');
    expect(launch[1]!.what).not.toContain('serve');
  });

  it('leaves alone what it cannot resolve: workspaces, compound commands, other toolchains', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nrouting:\n  ports:\n    - 3000\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/web', name: 'web' },
    ]);
    // Only `dev:api` here, so a naive lookup of `dev` would fire on the
    // workspace command - which runs `dev` in the workspace package, not
    // in this one.
    await file(
      'projects/web/package.json',
      JSON.stringify({
        scripts: { 'dev:api': 'x' },
        workspaces: ['packages/*'],
      }),
    );
    await file(
      'projects/web/.monoceros/launch.json',
      JSON.stringify({
        targets: [
          {
            name: 'api',
            command: 'npm run dev --workspace @acme/backend',
            port: 3000,
          },
          { name: 'chained', command: 'cd ui && npm run dev', port: 3000 },
          { name: 'maven', command: './mvnw spring-boot:run', port: 3000 },
          { name: 'installer', command: 'npm ci', port: 3000 },
        ],
      }),
    );

    const report = await runCheck(NAME, checkOpts());
    expect(
      report.findings.filter(
        (f) => f.rule === 'launch-config' && f.what.includes('script'),
      ),
    ).toEqual([]);
  });

  it('resolves the package.json under the target cwd', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nrouting:\n  ports:\n    - 3000\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/web', name: 'web' },
    ]);
    // The root package has `dev`, the one under `ui/` does not: the target
    // runs in `ui/`, so that is the package that decides.
    await file(
      'projects/web/package.json',
      JSON.stringify({ scripts: { dev: 'vite' } }),
    );
    await file(
      'projects/web/ui/package.json',
      JSON.stringify({ scripts: { start: 'vite' } }),
    );
    await file(
      'projects/web/.monoceros/launch.json',
      JSON.stringify({
        targets: [
          { name: 'ui', command: 'npm run dev', port: 3000, cwd: 'ui' },
        ],
      }),
    );

    const report = await runCheck(NAME, checkOpts());
    const launch = report.findings.filter((f) => f.rule === 'launch-config');
    expect(launch).toHaveLength(1);
    expect(launch[0]!.what).toContain('projects/web/ui/package.json');
  });

  it('flags a service config file at the standard location that nothing mounts', async () => {
    // The trap the briefing warns about: the agent can write the realm
    // from inside, the bind that feeds it lives in the yml on the host.
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nservices:\n  - name: keycloak\n    image: quay.io/keycloak/keycloak:26.6\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/shop', name: 'shop' },
    ]);
    await file(
      'projects/shop/keycloak/realm.json',
      JSON.stringify({ realm: 'shop', clients: [] }),
    );

    const report = await runCheck(NAME, checkOpts());
    const found = report.findings.filter((f) => f.rule === 'service-config');
    expect(found).toHaveLength(1);
    expect(found[0]!.where).toBe('projects/shop/keycloak/realm.json');
    // Read from the file, not guessed from its name.
    expect(found[0]!.what).toContain('Declares the realm `shop`');
    // Paste-ready volume spec, with <app> filled in on both sides.
    expect(found[0]!.fix).toContain(
      'projects/shop/keycloak/realm.json:/opt/keycloak/data/import/shop.json:ro',
    );
  });

  it('says nothing when the yml already mounts that file', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nservices:\n  - name: keycloak\n    image: quay.io/keycloak/keycloak:26.6\n    volumes:\n      - projects/shop/keycloak/realm.json:/opt/keycloak/data/import/shop.json:ro\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/shop', name: 'shop' },
    ]);
    await file(
      'projects/shop/keycloak/realm.json',
      JSON.stringify({ realm: 'shop' }),
    );

    const report = await runCheck(NAME, checkOpts());
    expect(report.findings.filter((f) => f.rule === 'service-config')).toEqual(
      [],
    );
  });

  it('flags two targets on one port and a port nothing declares', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nrouting:\n  ports:\n    - 3000\n    - 9999\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/web', name: 'web' },
      { path: 'projects/api', name: 'api' },
    ]);
    await file(
      'projects/web/.monoceros/launch.json',
      JSON.stringify({
        targets: [{ name: 'web', command: 'npm run dev', port: 3000 }],
      }),
    );
    await file(
      'projects/api/.monoceros/launch.json',
      JSON.stringify({
        targets: [{ name: 'api', command: 'npm start', port: 3000 }],
      }),
    );

    const report = await runCheck(NAME, checkOpts());
    const ports = report.findings.filter((f) => f.rule === 'ports');
    expect(ports.map((f) => f.where)).toEqual(['port 3000', 'port 9999']);
    expect(ports[0]!.what).toContain('api → api');
    expect(ports[0]!.what).toContain('web → web');
    expect(ports[1]!.fix).toContain('monoceros remove-port acme 9999');
  });

  it('does not call an exposed port dead while no app declares a launch config', async () => {
    // The normal state right after `init --with-ports`: the apps are still
    // to be built, and every port would show up as a dead route.
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nrouting:\n  ports:\n    - 3000\n',
    );
    const report = await runCheck(NAME, checkOpts());
    expect(report.findings.filter((f) => f.rule === 'ports')).toEqual([]);
  });

  it('flags a briefing file whose marker pair is gone', async () => {
    await scaffold();
    await briefing('CLAUDE.md', '@AGENTS.md\n');
    await file('AGENTS.md', '# my own notes, markers deleted\n');

    const report = await runCheck(NAME, checkOpts());
    const markers = report.findings.filter(
      (f) => f.rule === 'briefing-markers',
    );
    expect(markers.map((f) => f.where)).toEqual(['AGENTS.md']);
    expect(markers[0]!.what).toContain('rewrites this file whole');
  });

  it('finds a server marker one level down and counts a nested launch config as covered', async () => {
    await scaffold(
      'schemaVersion: 1\nname: acme\nlanguages:\n  - node\nrouting:\n  ports:\n    - 3000\n',
    );
    await workspace([
      { path: '.', name: 'workspace' },
      { path: 'projects/shop', name: 'shop' },
      { path: 'projects/blog', name: 'blog' },
    ]);
    // shop/backend serves and nothing declares it.
    await file('projects/shop/backend/manage.py', '#!/usr/bin/env python\n');
    // blog/web serves and its own launch config covers the project.
    await file(
      'projects/blog/web/package.json',
      JSON.stringify({ scripts: { dev: 'vite' } }),
    );
    await file(
      'projects/blog/web/.monoceros/launch.json',
      JSON.stringify({
        targets: [{ name: 'web', command: 'npm run dev', port: 3000 }],
      }),
    );

    const report = await runCheck(NAME, checkOpts());
    const launch = report.findings.filter((f) => f.rule === 'launch-config');
    expect(launch.map((f) => f.where)).toEqual([
      'projects/shop/backend/manage.py',
    ]);
  });
});

describe('renderCheckReport', () => {
  const plain = colorsFor({ isTTY: false } as NodeJS.WriteStream);

  it('names what was checked when there is nothing to report', () => {
    const out = renderCheckReport(
      {
        name: 'acme',
        findings: [],
        scanned: { projects: 2, composeFiles: 1, apps: 1 },
      },
      plain,
    );
    expect(out).toContain('Nothing to report.');
    expect(out).toContain(
      'Checked 2 projects, 1 compose file, 1 launch config.',
    );
  });

  it('groups findings by rule and ends with the count', () => {
    const out = renderCheckReport(
      {
        name: 'acme',
        findings: [
          {
            rule: 'workspace-registration',
            where: 'projects/shop',
            what: 'Not listed.',
            fix: 'Add it.',
          },
          {
            rule: 'compose-drift',
            where: 'projects/api/compose.yaml → services.postgres',
            what: 'Wrong tag.',
            fix: 'Copy the block.',
          },
        ],
        scanned: { projects: 1, composeFiles: 1, apps: 0 },
      },
      plain,
    );
    expect(out).toContain('Workspace registration');
    expect(out).toContain('Compose drift');
    expect(out).toContain('→ Add it.');
    expect(out).toContain('2 findings in 1 project, 1 compose file');
    expect(out).toContain('Nothing was changed.');
  });
});

/**
 * #74: the container declares ports, Traefik has the route, but the
 * container is not on the monoceros-proxy network — so every request
 * answers 502 and nothing in the workbench says why. The rule needs a
 * RUNNING container to decide, and stays silent otherwise.
 */
describe('runCheck: proxy-network attachment (#74)', () => {
  const NETWORKS_FORMAT = '{{json .NetworkSettings.Networks}}';

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-check-proxy-'));
    await mkdir(containerRoot(), { recursive: true });
    await workspace([]);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const running = (id: string) => async () => ({
    stdout: `${id}\n`,
    stderr: '',
    exitCode: 0,
  });

  const networks = (json: string) => async (args: string[]) =>
    args.includes(NETWORKS_FORMAT)
      ? { stdout: json, stderr: '', exitCode: 0 }
      : { stdout: '', stderr: '', exitCode: 0 };

  it('reports the 502 cause when a running container is not on the network', async () => {
    await writeYml(
      'schemaVersion: 1\nname: acme\nrouting:\n  ports:\n    - 3000\n',
    );
    const report = await runCheck(
      NAME,
      checkOpts({
        containerLookupDocker: running('c0ffee123456'),
        proxyDocker: networks('{"bridge":{}}'),
      }),
    );
    const finding = report.findings.find(
      (f) => f.where === `container ${NAME}`,
    );
    expect(finding).toBeDefined();
    expect(finding?.what).toContain('502');
    expect(finding?.fix).toContain(`monoceros add-port ${NAME} 3000`);
  });

  it('says nothing when the container is on the network', async () => {
    await writeYml(
      'schemaVersion: 1\nname: acme\nrouting:\n  ports:\n    - 3000\n',
    );
    const report = await runCheck(
      NAME,
      checkOpts({
        containerLookupDocker: running('c0ffee123456'),
        proxyDocker: networks('{"monoceros-proxy":{"Aliases":["acme"]}}'),
      }),
    );
    expect(report.findings.some((f) => f.where === `container ${NAME}`)).toBe(
      false,
    );
  });

  it('says nothing when no container is running — the next apply attaches it', async () => {
    await writeYml(
      'schemaVersion: 1\nname: acme\nrouting:\n  ports:\n    - 3000\n',
    );
    const report = await runCheck(
      NAME,
      checkOpts({ proxyDocker: networks('{"bridge":{}}') }),
    );
    expect(report.findings.some((f) => f.where === `container ${NAME}`)).toBe(
      false,
    );
  });

  it('never asks docker at all when the yml declares no ports', async () => {
    await writeYml('schemaVersion: 1\nname: acme\n');
    let asked = false;
    await runCheck(
      NAME,
      checkOpts({
        containerLookupDocker: async () => {
          asked = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        },
      }),
    );
    expect(asked).toBe(false);
  });

  it('stays silent when docker cannot answer which networks the container has', async () => {
    await writeYml(
      'schemaVersion: 1\nname: acme\nrouting:\n  ports:\n    - 3000\n',
    );
    const report = await runCheck(
      NAME,
      checkOpts({
        containerLookupDocker: running('c0ffee123456'),
        proxyDocker: async () => ({
          stdout: '',
          stderr: 'No such object',
          exitCode: 1,
        }),
      }),
    );
    expect(report.findings.some((f) => f.where === `container ${NAME}`)).toBe(
      false,
    );
  });
});
