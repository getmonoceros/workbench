import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  gatherStatus,
  renderApp,
  renderService,
  renderStatus,
  type StatusModel,
} from '../src/status/index.js';
import type { DockerLookupExec } from '../src/devcontainer/locate-running.js';
import { colorsFor } from '../src/util/format.js';

// Non-TTY palette: helpers pass strings through unchanged, so assertions can
// match on the literal `▸`, `✓`, `·` and text without ANSI noise.
const plain = colorsFor({ isTTY: false } as unknown as NodeJS.WriteStream);

let home: string;

const YML = [
  'schemaVersion: 1',
  'runtimeVersion: 1.6.0',
  'name: acme',
  'languages:',
  '  - node',
  '  - python',
  'features:',
  '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
  'services:',
  '  - name: postgres',
  '    image: postgres:16',
  '    port: 5432',
  'routing:',
  '  ports:',
  '    - 3000',
  '',
].join('\n');

async function writeFixture(): Promise<void> {
  await mkdir(path.join(home, 'container-configs'), { recursive: true });
  await writeFile(path.join(home, 'container-configs', 'acme.yml'), YML);
  const lc = path.join(
    home,
    'container',
    'acme',
    'projects',
    'web',
    '.monoceros',
  );
  await mkdir(lc, { recursive: true });
  await writeFile(
    path.join(lc, 'launch.json'),
    JSON.stringify({
      version: 1,
      configurations: [
        { name: 'dev', command: 'npm run dev', port: 3000, default: true },
        { name: 'worker', command: 'npm run worker' },
      ],
    }),
  );
}

/** docker fake: keys off the argv to answer ps (container), ps (services), exec. */
function makeDocker(opts: {
  containerRow?: string;
  serviceRows?: string;
  appJson?: string;
  appExit?: number;
}): DockerLookupExec {
  return async (args) => {
    const a = args.join(' ');
    if (a.includes('exec')) {
      return {
        stdout: opts.appJson ?? '',
        stderr: '',
        exitCode: opts.appExit ?? 0,
      };
    }
    // The service query filters by `label=com.docker.compose.project=<proj>`;
    // the container query only *formats* that label, so key off the filter.
    if (a.includes('label=com.docker.compose.project=')) {
      return { stdout: opts.serviceRows ?? '', stderr: '', exitCode: 0 };
    }
    return {
      stdout: opts.containerRow ?? '',
      stderr: '',
      exitCode: 0,
    };
  };
}

const RUNNING = {
  containerRow: 'abc123\trunning\tUp 2 hours\tmonoceros-acme\tacme_proj\n',
  serviceRows: 'workspace\trunning\tUp 2 hours\npostgres\trunning\tUp 1 hour\n',
  appJson:
    '{"app":"web","target":"dev","running":true,"pid":412,"port":3000,"default":true}\n' +
    '{"app":"web","target":"worker","running":false,"pid":null,"port":null,"default":false}\n',
};

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'monoceros-status-'));
  await writeFixture();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('gatherStatus', () => {
  it('builds the full model from yml + docker (container up)', async () => {
    const m = await gatherStatus('acme', { home, docker: makeDocker(RUNNING) });

    expect(m.configured).toBe(true);
    expect(m.container).toMatchObject({
      exists: true,
      running: true,
      dockerName: 'monoceros-acme',
      status: 'Up 2 hours',
    });

    expect(m.services.map((s) => s.name)).toEqual(['postgres']);
    expect(m.services[0]!.running).toBe(true);

    expect(m.appStateKnown).toBe(true);
    const dev = m.apps.find((a) => a.target === 'dev')!;
    expect(dev).toMatchObject({
      app: 'web',
      running: true,
      pid: 412,
      port: 3000,
      default: true,
    });
    const worker = m.apps.find((a) => a.target === 'worker')!;
    expect(worker.running).toBe(false);

    expect(m.ports).toEqual([
      { port: 3000, url: 'http://acme-3000.localhost', isDefault: true },
    ]);
    expect(m.builtIn.languages).toContain('node');
    expect(m.builtIn.features).toContain('claude-code');
  });

  it('marks app state unknown when the container is down', async () => {
    const m = await gatherStatus('acme', {
      home,
      docker: makeDocker({
        containerRow:
          'abc123\texited\tExited (0) 5 minutes ago\tmonoceros-acme\tacme_proj\n',
        serviceRows: 'postgres\texited\tExited (0) 5 minutes ago\n',
      }),
    });
    expect(m.container.running).toBe(false);
    expect(m.appStateKnown).toBe(false);
    expect(m.appStateNote).toMatch(/start the container/);
    // inventory still lists the targets, just without live state
    expect(m.apps.map((a) => a.target).sort()).toEqual(['dev', 'worker']);
    expect(m.apps.every((a) => a.running === undefined)).toBe(true);
    expect(m.services[0]!.running).toBe(false);
  });

  it('explains when the running image cannot report app state', async () => {
    // yml pins 1.6.0 so the gate passes, but the image's runner rejects
    // `list --json` (predates the NDJSON surface) → exitCode != 0.
    const m = await gatherStatus('acme', {
      home,
      docker: makeDocker({
        containerRow: RUNNING.containerRow,
        serviceRows: RUNNING.serviceRows,
        appExit: 2,
      }),
    });
    expect(m.appStateKnown).toBe(false);
    expect(m.appStateNote).toMatch(/upgrade/);
    expect(m.apps.every((a) => a.running === undefined)).toBe(true);
  });

  it('reports a not-created container', async () => {
    const m = await gatherStatus('acme', { home, docker: makeDocker({}) });
    expect(m.container.exists).toBe(false);
  });

  it('notes an old runtime cannot report app state', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'acme.yml'),
      YML.replace('1.6.0', '1.5.0'),
    );
    const m = await gatherStatus('acme', { home, docker: makeDocker(RUNNING) });
    expect(m.appStateKnown).toBe(false);
    expect(m.appStateNote).toMatch(/1\.6\.0/);
  });
});

describe('renderStatus', () => {
  it('renders every section with the right markers', async () => {
    const m = await gatherStatus('acme', { home, docker: makeDocker(RUNNING) });
    const out = renderStatus(m, plain);

    expect(out).toContain('▸ acme');
    expect(out).toContain('monoceros-acme');
    expect(out).toContain('▸ Services');
    expect(out).toContain('postgres');
    expect(out).toContain('▸ Apps');
    expect(out).toContain('web');
    expect(out).toContain('http://acme-3000.localhost');
    expect(out).toContain('pid 412');
    expect(out).toContain('(default)');
    expect(out).toContain('▸ Ports');
    expect(out).toContain('acme.localhost · acme-3000.localhost');
    expect(out).toContain('▸ Built in');
    expect(out).toContain('claude-code');
    expect(out).toContain('node');
    // running marker present for the up container, down marker for the worker
    expect(out).toContain('✓');
    expect(out).toContain('·');
  });

  it('shows (not created) when the container is absent', async () => {
    const m = await gatherStatus('acme', { home, docker: makeDocker({}) });
    expect(renderStatus(m, plain)).toContain('(not created)');
  });
});

describe('focused views', () => {
  it('renderApp shows one app and throws for an unknown one', async () => {
    const m = await gatherStatus('acme', { home, docker: makeDocker(RUNNING) });
    const out = renderApp(m, 'web', plain);
    expect(out).toContain('▸ web');
    expect(out).toContain('dev');
    expect(out).toContain('worker');
    expect(() => renderApp(m, 'nope', plain)).toThrow(/No app "nope"/);
  });

  it('renderService shows one service and throws for an unknown one', async () => {
    const m = await gatherStatus('acme', { home, docker: makeDocker(RUNNING) });
    expect(renderService(m, 'postgres', plain)).toContain('postgres');
    expect(() => renderService(m, 'redis', plain)).toThrow(
      /No service "redis"/,
    );
  });
});

describe('renderStatus (hand-built model)', () => {
  it('renders a minimal model without optional sections', () => {
    const m: StatusModel = {
      name: 'bare',
      configured: true,
      container: {
        exists: true,
        running: true,
        status: 'Up 1 minute',
        dockerName: 'monoceros-bare',
      },
      services: [],
      apps: [],
      appStateKnown: true,
      ports: [],
      builtIn: { languages: [], features: [] },
    };
    const out = renderStatus(m, plain);
    expect(out).toContain('▸ bare');
    expect(out).not.toContain('▸ Services');
    expect(out).not.toContain('▸ Apps');
    expect(out).not.toContain('▸ Ports');
    expect(out).not.toContain('▸ Built in');
  });
});
