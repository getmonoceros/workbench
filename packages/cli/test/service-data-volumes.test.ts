import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateServiceDataVolumes } from '../src/apply/service-data-volumes.js';
import { composeServiceDataVolumes } from '../src/remove/service-data-volumes.js';
import type { ResolvedService } from '../src/create/types.js';

const silentLogger = { info: () => {}, warn: () => {} };

function service(name: string, volumes: string[]): ResolvedService {
  return { name, image: `${name}:test`, env: {}, volumes } as ResolvedService;
}

/**
 * Docker stub. `existingVolumes` decides what `volume inspect` finds;
 * every call is captured for assertions.
 */
function dockerStub(
  calls: string[][],
  opts: {
    existingVolumes?: string[];
    failCopy?: boolean;
    /** Container ids `docker ps` reports for the running service. */
    runningIds?: string[];
  } = {},
) {
  const existing = new Set(opts.existingVolumes ?? []);
  return (args: string[]) => {
    calls.push([...args]);
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return Promise.resolve({
        exitCode: existing.has(args[2]!) ? 0 : 1,
        stdout: '',
        stderr: existing.has(args[2]!) ? '' : 'no such volume',
      });
    }
    if (args[0] === 'ps') {
      return Promise.resolve({
        exitCode: 0,
        stdout: (opts.runningIds ?? []).join('\n'),
        stderr: '',
      });
    }
    if (args[0] === 'run' && opts.failCopy) {
      return Promise.resolve({
        exitCode: 1,
        stdout: '',
        stderr: 'copy blew up',
      });
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  };
}

describe('migrateServiceDataVolumes (pre-0036 migration)', () => {
  let targetDir: string;

  beforeEach(async () => {
    targetDir = await mkdtemp(path.join(tmpdir(), 'monoceros-seed-'));
  });

  afterEach(async () => {
    await rm(targetDir, { recursive: true, force: true });
  });

  /** Populate the old host-side data dir of one service. */
  async function seedOldDataDir(svc: string): Promise<string> {
    const dir = path.join(targetDir, 'data', svc);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'PG_VERSION'), '18\n');
    return dir;
  }

  it('copies an existing data/<svc>/ into a freshly created volume', async () => {
    const hostDir = await seedOldDataDir('postgres');
    const calls: string[][] = [];
    await migrateServiceDataVolumes({
      name: 'acme',
      targetDir,
      services: [service('postgres', ['data:/var/lib/postgresql'])],
      dockerExec: dockerStub(calls),
      logger: silentLogger,
    });

    const text = calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('volume create monoceros-acme-data-postgres');
    expect(text).toContain(`${hostDir}:/src:ro`);
    expect(text).toContain('monoceros-acme-data-postgres:/dst');
    expect(text).toContain('cp -a /src/. /dst/');
    // The builder's data stays where it is; nothing deletes it.
    await expect(
      import('node:fs/promises').then((fs) => fs.readdir(hostDir)),
    ).resolves.toEqual(['PG_VERSION']);
  });

  it('stops the still-running service before copying, so the cluster is quiescent', async () => {
    await seedOldDataDir('postgres');
    const calls: string[][] = [];
    await migrateServiceDataVolumes({
      name: 'acme',
      targetDir,
      services: [service('postgres', ['data:/var/lib/postgresql'])],
      dockerExec: dockerStub(calls, { runningIds: ['abc123', 'def456'] }),
      logger: silentLogger,
    });

    const ps = calls.find((c) => c[0] === 'ps')!;
    // Scoped to THIS container's service by both compose labels.
    expect(ps.join(' ')).toContain(
      `label=com.docker.compose.project=${path.basename(targetDir).toLowerCase()}_devcontainer`,
    );
    expect(ps.join(' ')).toContain('label=com.docker.compose.service=postgres');
    const stopIndex = calls.findIndex((c) => c[0] === 'stop');
    expect(calls[stopIndex]).toEqual(['stop', 'abc123', 'def456']);
    // …and the stop happens BEFORE the copy, or the copy tears the cluster.
    const copyIndex = calls.findIndex((c) => c[0] === 'run');
    expect(stopIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeLessThan(copyIndex);
  });

  it('skips the stop when the service is not running', async () => {
    await seedOldDataDir('postgres');
    const calls: string[][] = [];
    await migrateServiceDataVolumes({
      name: 'acme',
      targetDir,
      services: [service('postgres', ['data:/var/lib/postgresql'])],
      dockerExec: dockerStub(calls, { runningIds: [] }),
      logger: silentLogger,
    });
    expect(calls.some((c) => c[0] === 'stop')).toBe(false);
    expect(calls.some((c) => c[0] === 'run')).toBe(true);
  });

  it('does nothing when the volume already exists (idempotent re-apply)', async () => {
    await seedOldDataDir('postgres');
    const calls: string[][] = [];
    await migrateServiceDataVolumes({
      name: 'acme',
      targetDir,
      services: [service('postgres', ['data:/var/lib/postgresql'])],
      dockerExec: dockerStub(calls, {
        existingVolumes: ['monoceros-acme-data-postgres'],
      }),
      logger: silentLogger,
    });
    const text = calls.map((c) => c.join(' ')).join('\n');
    expect(text).toContain('volume inspect');
    expect(text).not.toContain('volume create');
    expect(text).not.toContain('cp -a');
  });

  it('does nothing for a fresh container (no old data dir) — compose creates the volume', async () => {
    const calls: string[][] = [];
    await migrateServiceDataVolumes({
      name: 'acme',
      targetDir,
      services: [service('postgres', ['data:/var/lib/postgresql'])],
      dockerExec: dockerStub(calls),
      logger: silentLogger,
    });
    expect(calls).toEqual([]);
  });

  it('ignores services without a data: volume', async () => {
    await mkdir(path.join(targetDir, 'data', 'keycloak'), { recursive: true });
    await writeFile(path.join(targetDir, 'data', 'keycloak', 'x'), 'x');
    const calls: string[][] = [];
    await migrateServiceDataVolumes({
      name: 'acme',
      targetDir,
      services: [service('keycloak', ['themes:/opt/keycloak/themes'])],
      dockerExec: dockerStub(calls),
      logger: silentLogger,
    });
    expect(calls).toEqual([]);
  });

  it('removes the half-filled volume and throws when the copy fails', async () => {
    await seedOldDataDir('postgres');
    const calls: string[][] = [];
    await expect(
      migrateServiceDataVolumes({
        name: 'acme',
        targetDir,
        services: [service('postgres', ['data:/var/lib/postgresql'])],
        dockerExec: dockerStub(calls, { failCopy: true }),
        logger: silentLogger,
      }),
    ).rejects.toThrow(/copy blew up/);
    // A volume left half-populated would be treated as migrated on the
    // next apply and start the database on truncated data.
    expect(calls.map((c) => c.join(' '))).toContain(
      'volume rm -f monoceros-acme-data-postgres',
    );
  });
});

describe('composeServiceDataVolumes', () => {
  let containerPath: string;

  beforeEach(async () => {
    containerPath = await mkdtemp(path.join(tmpdir(), 'monoceros-compose-'));
  });

  afterEach(async () => {
    await rm(containerPath, { recursive: true, force: true });
  });

  async function writeCompose(lines: string[]): Promise<void> {
    const dir = path.join(containerPath, '.devcontainer');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'compose.yaml'), lines.join('\n'));
  }

  it('reads the data volumes and their service names, skipping IDE volumes', async () => {
    await writeCompose([
      'services:',
      '  postgres:',
      '    volumes:',
      '      - monoceros-acme-data-postgres:/var/lib/postgresql',
      'volumes:',
      '  monoceros-acme-vscode-extensions:',
      '    name: monoceros-acme-vscode-extensions',
      // The IDE volume that a `-data` SUFFIX scheme mistook for a
      // service's data (it got copied into the backup as data/jetbrains/).
      // The fixed `-data-` prefix cannot confuse the two.
      '  monoceros-acme-jetbrains-data:',
      '    name: monoceros-acme-jetbrains-data',
      '  monoceros-acme-claude-remote:',
      '    name: monoceros-acme-claude-remote',
      '  monoceros-acme-data-postgres:',
      '    name: monoceros-acme-data-postgres',
      '  monoceros-acme-data-my-cache:',
      '    name: monoceros-acme-data-my-cache',
      '',
    ]);
    await expect(
      composeServiceDataVolumes(containerPath, 'acme'),
    ).resolves.toEqual([
      { service: 'postgres', volume: 'monoceros-acme-data-postgres' },
      // Service names may contain dashes; everything after the fixed
      // prefix is the service name.
      { service: 'my-cache', volume: 'monoceros-acme-data-my-cache' },
    ]);
  });

  it('returns nothing when the container was never applied', async () => {
    await expect(
      composeServiceDataVolumes(containerPath, 'acme'),
    ).resolves.toEqual([]);
  });
});
