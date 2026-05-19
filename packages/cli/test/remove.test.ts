import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRemove } from '../src/remove/index.js';

const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
};

/** No-op docker spawn — runRemove still calls through, we just capture
 *  the script for the assertion and return 0. */
function captureDockerSpawn(captured: string[]): typeof spawnStub {
  function spawnStub(args: string[]): Promise<number> {
    // -c "...script..."
    if (args[0] === '-c' && typeof args[1] === 'string') {
      captured.push(args[1]);
    }
    return Promise.resolve(0);
  }
  return spawnStub;
}

describe('runRemove', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-remove-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    await mkdir(path.join(home, 'container'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** Seed one container's host-side state. */
  async function seedContainer(
    name: string,
    opts: { withData?: boolean } = {},
  ): Promise<void> {
    await writeFile(
      path.join(home, 'container-configs', `${name}.yml`),
      `schemaVersion: 1\nname: ${name}\n`,
    );
    const dir = path.join(home, 'container', name);
    await mkdir(path.join(dir, 'home', '.claude'), { recursive: true });
    await writeFile(
      path.join(dir, 'home', '.claude', '.credentials.json'),
      '{"fake":"token"}',
    );
    await mkdir(path.join(dir, 'projects'), { recursive: true });
    if (opts.withData) {
      await mkdir(path.join(dir, 'data', 'postgres'), { recursive: true });
      await writeFile(
        path.join(dir, 'data', 'postgres', 'pretend.dat'),
        'rows',
      );
    }
  }

  it('removes docker objects, backs up yml + container dir, and deletes them', async () => {
    await seedContainer('sandbox', { withData: true });
    const dockerCalls: string[] = [];
    const result = await runRemove({
      name: 'sandbox',
      monocerosHome: home,
      now: new Date('2026-06-01T12:00:00Z'),
      dockerSpawn: captureDockerSpawn(dockerCalls),
      logger: silentLogger,
    });

    // docker cleanup script ran with the expected scope
    expect(dockerCalls).toHaveLength(1);
    expect(dockerCalls[0]).toContain(
      'label=com.docker.compose.project=sandbox_devcontainer',
    );
    expect(dockerCalls[0]).toContain('name=^sandbox_devcontainer-');
    expect(dockerCalls[0]).toContain('name=^vsc-sandbox-');

    // yml + container dir are gone
    expect(result.dockerExitCode).toBe(0);
    expect(result.configPath).toBe(
      path.join(home, 'container-configs', 'sandbox.yml'),
    );
    expect(result.containerPath).toBe(path.join(home, 'container', 'sandbox'));
    const cfgsLeft = await readdir(path.join(home, 'container-configs'));
    expect(cfgsLeft).not.toContain('sandbox.yml');
    const dirsLeft = await readdir(path.join(home, 'container'));
    expect(dirsLeft).not.toContain('sandbox');

    // backup landed under container-backups/<name>-<ts>/
    expect(result.backupPath).toMatch(/container-backups\/sandbox-/);
    const backupChildren = await readdir(result.backupPath!);
    expect(backupChildren.sort()).toEqual(['container', 'sandbox.yml']);
    // home state survived in the backup
    const creds = await readFile(
      path.join(
        result.backupPath!,
        'container',
        'home',
        '.claude',
        '.credentials.json',
      ),
      'utf8',
    );
    expect(creds).toBe('{"fake":"token"}');
    // DB data survived in the backup
    const dat = await readFile(
      path.join(
        result.backupPath!,
        'container',
        'data',
        'postgres',
        'pretend.dat',
      ),
      'utf8',
    );
    expect(dat).toBe('rows');
  });

  it('skips the backup step under --no-backup', async () => {
    await seedContainer('sandbox');
    const dockerCalls: string[] = [];
    const result = await runRemove({
      name: 'sandbox',
      noBackup: true,
      monocerosHome: home,
      dockerSpawn: captureDockerSpawn(dockerCalls),
      logger: silentLogger,
    });
    expect(result.backupPath).toBeNull();
    // The backups dir was never created.
    await expect(
      readdir(path.join(home, 'container-backups')),
    ).rejects.toThrow();
    // State is still gone.
    const dirsLeft = await readdir(path.join(home, 'container'));
    expect(dirsLeft).not.toContain('sandbox');
  });

  it('errors when nothing exists for the name', async () => {
    await expect(
      runRemove({
        name: 'never-there',
        monocerosHome: home,
        dockerSpawn: captureDockerSpawn([]),
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Nothing to remove/);
  });

  it('still does docker cleanup + delete when only the yml exists (container dir was never applied)', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'half.yml'),
      'schemaVersion: 1\nname: half\n',
    );
    const dockerCalls: string[] = [];
    const result = await runRemove({
      name: 'half',
      monocerosHome: home,
      dockerSpawn: captureDockerSpawn(dockerCalls),
      logger: silentLogger,
    });
    expect(dockerCalls).toHaveLength(1);
    expect(result.configPath).toBe(
      path.join(home, 'container-configs', 'half.yml'),
    );
    expect(result.containerPath).toBeNull();
    // Backup contains only the yml.
    const children = await readdir(result.backupPath!);
    expect(children).toEqual(['half.yml']);
  });

  it('rejects an invalid container name without touching disk', async () => {
    await seedContainer('sandbox');
    await expect(
      runRemove({
        name: 'has space',
        monocerosHome: home,
        dockerSpawn: captureDockerSpawn([]),
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Invalid config name/);
    // sandbox is intact — the error happened before any side effect.
    const dirsLeft = await readdir(path.join(home, 'container'));
    expect(dirsLeft).toContain('sandbox');
  });
});

// Helper type for the stub above.
type spawnStub = (args: string[]) => Promise<number>;
