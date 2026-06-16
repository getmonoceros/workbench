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

/** No-op docker exec — runRemove still calls through, we capture
 *  each docker invocation's args (one array per call) and return 0
 *  with empty stdout/stderr. With the bash-script approach gone, the
 *  cleanup now drives docker directly via multiple Node spawns, so
 *  the capture is a list of arg arrays rather than one big script. */
function captureDockerExec(captured: string[][]): typeof execStub {
  function execStub(
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    captured.push([...args]);
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
  }
  return execStub;
}

/** Flatten captured arg arrays into a single string for substring
 *  assertions. Joining with `\n` keeps individual call boundaries
 *  visible in test failure output. */
function flattenCalls(calls: string[][]): string {
  return calls.map((c) => c.join(' ')).join('\n');
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
    const dockerCalls: string[][] = [];
    const result = await runRemove({
      name: 'sandbox',
      monocerosHome: home,
      now: new Date('2026-06-01T12:00:00Z'),
      dockerExec: captureDockerExec(dockerCalls),
      proxyDocker: captureDockerExec([]),
      logger: silentLogger,
    });

    // Cleanup drove docker directly (no shell), and walked through
    // all four filters + the network removal:
    //   - one `docker ps -aq --filter <X>` per filter (4 calls)
    //   - no `docker rm -f` because the stub returned empty stdout
    //   - one `docker network rm <project>_default`
    const flat = flattenCalls(dockerCalls);
    expect(flat).toContain(
      'label=com.docker.compose.project=sandbox_devcontainer',
    );
    // Devcontainer-cli label filter — anchors on the container-dir
    // path because @devcontainers/cli lets Docker assign random
    // container names that name-prefix filters can't match.
    expect(flat).toContain(
      `label=devcontainer.local_folder=${path.join(home, 'container', 'sandbox')}`,
    );
    expect(flat).toContain('name=^sandbox_devcontainer-');
    expect(flat).toContain('name=^vsc-sandbox-');
    expect(flat).toContain('network rm sandbox_devcontainer_default');

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

  it('deletes per-container IDE volumes but spares the shared JetBrains backend', async () => {
    await seedContainer('sandbox');
    const dockerCalls: string[][] = [];
    await runRemove({
      name: 'sandbox',
      monocerosHome: home,
      dockerExec: captureDockerExec(dockerCalls),
      proxyDocker: captureDockerExec([]),
      logger: silentLogger,
    });
    const volumeRm = dockerCalls.find(
      (c) => c[0] === 'volume' && c[1] === 'rm',
    );
    expect(volumeRm).toBeDefined();
    // Per-container volumes are removed...
    expect(volumeRm).toContain('monoceros-sandbox-jetbrains-cache');
    expect(volumeRm).toContain('monoceros-sandbox-vscode-extensions');
    // ...but the machine-wide shared backend is NOT (other containers use it).
    expect(volumeRm).not.toContain('monoceros-jetbrains-dist');
  });

  it('skips the backup step under --no-backup', async () => {
    await seedContainer('sandbox');
    const dockerCalls: string[][] = [];
    const result = await runRemove({
      name: 'sandbox',
      noBackup: true,
      monocerosHome: home,
      dockerExec: captureDockerExec(dockerCalls),
      proxyDocker: captureDockerExec([]),
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
        dockerExec: captureDockerExec([]),
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Nothing to remove/);
  });

  it('still does docker cleanup + delete when only the yml exists (container dir was never applied)', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'half.yml'),
      'schemaVersion: 1\nname: half\n',
    );
    const dockerCalls: string[][] = [];
    const result = await runRemove({
      name: 'half',
      monocerosHome: home,
      dockerExec: captureDockerExec(dockerCalls),
      proxyDocker: captureDockerExec([]),
      logger: silentLogger,
    });
    // 4 ps-filter calls + 1 network rm = 5 docker invocations.
    expect(dockerCalls.length).toBeGreaterThan(0);
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
        dockerExec: captureDockerExec([]),
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Invalid config name/);
    // sandbox is intact — the error happened before any side effect.
    const dirsLeft = await readdir(path.join(home, 'container'));
    expect(dirsLeft).toContain('sandbox');
  });
});
