import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  renderCheckReport,
  runCheck,
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
    await expect(runCheck(NAME, { home })).rejects.toThrow(
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

    const report = await runCheck(NAME, { home });
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

    const report = await runCheck(NAME, { home });
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
    await file('AGENTS.md', '# briefing\n');
    await file('CLAUDE.md', '@AGENTS.md\n');
    await file('.monoceros/commands.md', '# commands\n');
    await file('package.json', '{"name":"oops"}');
    await mkdir(path.join(containerRoot(), 'src'), { recursive: true });

    const report = await runCheck(NAME, { home });
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

    const report = await runCheck(NAME, { home });
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

    const report = await runCheck(NAME, { home });
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

    const report = await runCheck(NAME, { home });
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

    const report = await runCheck(NAME, { home });
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

    const report = await runCheck(NAME, { home });
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

    const report = await runCheck(NAME, { home });
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

    const report = await runCheck(NAME, { home });
    const launch = report.findings.filter((f) => f.rule === 'launch-config');
    expect(launch.map((f) => f.where)).toEqual([
      'projects/web/.monoceros/launch.json → admin',
      'projects/web/.monoceros/launch.json → api',
    ]);
    expect(launch[0]!.what).toContain('Port 4200 is not exposed');
    expect(launch[0]!.fix).toContain('monoceros add-port acme 4200');
    expect(launch[1]!.what).toContain('--host 127.0.0.1');
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

    const report = await runCheck(NAME, { home });
    const launch = report.findings.filter((f) => f.rule === 'launch-config');
    expect(launch).toHaveLength(1);
    expect(launch[0]!.where).toBe('projects/web/package.json');
    expect(launch[0]!.what).toContain('`dev` script');
    expect(launch[0]!.fix).toContain('projects/web/.monoceros/launch.json');
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

    const report = await runCheck(NAME, { home });
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
