import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveCompose,
  runContainerCycle,
  runLogs,
  runStart,
  runStatus,
  runStop,
  startDeferredServices,
} from '../src/devcontainer/compose.js';

describe('resolveCompose', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'monoceros-compose-resolve-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('throws when the container root has no .devcontainer/', () => {
    expect(() => resolveCompose(tmp)).toThrow(/No \.devcontainer\/ at/);
  });

  it('throws with a guiding message when compose.yaml is missing', async () => {
    const solution = path.join(tmp, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    expect(() => resolveCompose(solution)).toThrow(/No compose\.yaml at/);
  });

  it('returns the compose file path and the project name', async () => {
    const solution = path.join(tmp, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    await fs.writeFile(
      path.join(solution, '.devcontainer', 'compose.yaml'),
      'services: {}\n',
    );
    expect(resolveCompose(solution)).toEqual({
      composeFile: path.join(solution, '.devcontainer', 'compose.yaml'),
      projectName: 'demo_devcontainer',
    });
  });
});

describe('compose actions', () => {
  let tmp: string;
  let solution: string;
  let composeFile: string;
  const projectName = 'demo_devcontainer';

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'monoceros-compose-action-'));
    solution = path.join(tmp, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    composeFile = path.join(solution, '.devcontainer', 'compose.yaml');
    await fs.writeFile(composeFile, 'services: {}\n');
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('runStart delegates to `devcontainer up` with the workspace folder', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const exitCode = await runStart({
      root: solution,
      logger: { info: () => {} },
      spawn: async (args, cwd) => {
        calls.push({ args, cwd });
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        args: [
          'up',
          '--workspace-folder',
          solution,
          '--mount-workspace-git-root=false',
        ],
        cwd: solution,
      },
    ]);
  });

  it('runStart adds --build-no-cache when noCache is set', async () => {
    const calls: string[][] = [];
    await runStart({
      root: solution,
      noCache: true,
      logger: { info: () => {} },
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(calls[0]).toContain('--build-no-cache');
  });

  it('runStart works without compose.yaml (image-mode) via devcontainer up', async () => {
    const bare = path.join(tmp, 'image-only');
    await fs.mkdir(path.join(bare, '.devcontainer'), { recursive: true });
    const calls: string[][] = [];
    const exitCode = await runStart({
      root: bare,
      logger: { info: () => {} },
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(calls[0]).toEqual([
      'up',
      '--workspace-folder',
      bare,
      '--mount-workspace-git-root=false',
    ]);
  });

  it('runStart still refuses without a .devcontainer/ (not applied)', async () => {
    const missing = path.join(tmp, 'never-applied');
    await fs.mkdir(missing, { recursive: true });
    await expect(
      runStart({
        root: missing,
        logger: { info: () => {} },
        spawn: async () => 0,
      }),
    ).rejects.toThrow(/No \.devcontainer\/ at/);
  });

  it('startDeferredServices brings the named services up -d in the project (ADR 0025)', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const exitCode = await startDeferredServices({
      root: solution,
      services: ['keycloak', 'authz'],
      spawn: async (args, cwd) => {
        calls.push({ args, cwd });
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        args: [
          '-f',
          composeFile,
          '-p',
          projectName,
          '--profile',
          'monoceros-deferred',
          'up',
          '-d',
          '--quiet-pull',
          'keycloak',
          'authz',
        ],
        cwd: solution,
      },
    ]);
  });

  it('startDeferredServices is a no-op with no deferred services', async () => {
    let called = false;
    const exitCode = await startDeferredServices({
      root: solution,
      services: [],
      spawn: async () => {
        called = true;
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(called).toBe(false);
  });

  it('startDeferredServices propagates the compose exit code', async () => {
    const exitCode = await startDeferredServices({
      root: solution,
      services: ['keycloak'],
      spawn: async () => 7,
    });
    expect(exitCode).toBe(7);
  });

  it('runStop issues `stop` and preserves volumes', async () => {
    const calls: string[][] = [];
    await runStop({
      root: solution,
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(calls).toEqual([['-f', composeFile, '-p', projectName, 'stop']]);
  });

  it('runStatus issues `ps`', async () => {
    const calls: string[][] = [];
    await runStatus({
      root: solution,
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(calls).toEqual([['-f', composeFile, '-p', projectName, 'ps']]);
  });

  it('runLogs follows by default', async () => {
    const calls: string[][] = [];
    await runLogs({
      root: solution,
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(calls).toEqual([
      ['-f', composeFile, '-p', projectName, 'logs', '-f'],
    ]);
  });

  it('runLogs with follow=false omits -f', async () => {
    const calls: string[][] = [];
    await runLogs({
      root: solution,
      follow: false,
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(calls).toEqual([['-f', composeFile, '-p', projectName, 'logs']]);
  });

  it('appends --service when filtering stop/status/logs', async () => {
    const calls: string[][] = [];
    await runStop({
      root: solution,
      service: 'postgres',
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    await runLogs({
      root: solution,
      service: 'redis',
      follow: false,
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(calls).toEqual([
      ['-f', composeFile, '-p', projectName, 'stop', 'postgres'],
      ['-f', composeFile, '-p', projectName, 'logs', 'redis'],
    ]);
  });

  it('propagates exit codes from docker compose', async () => {
    const exitCode = await runStatus({
      root: solution,
      spawn: async () => 5,
    });
    expect(exitCode).toBe(5);
  });
});

describe('runContainerCycle — bind-source retry (VirtioFS file-sync race)', () => {
  const baseOpts = {
    hasCompose: false as const,
    bindRetryDelayMs: 0,
    logger: { info: () => {} },
  };

  it('retries the up on "bind source path does not exist", then succeeds', async () => {
    let calls = 0;
    const code = await runContainerCycle('/root', {
      ...baseOpts,
      devcontainerSpawn: async (_args, _cwd, options) => {
        calls += 1;
        if (calls === 1) {
          options?.logSink?.write(
            'docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /host_mnt/x\n',
          );
          return 1;
        }
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(calls).toBe(2);
  });

  it('does NOT retry a non-bind failure', async () => {
    let calls = 0;
    const code = await runContainerCycle('/root', {
      ...baseOpts,
      devcontainerSpawn: async (_args, _cwd, options) => {
        calls += 1;
        options?.logSink?.write('some other build error\n');
        return 1;
      },
    });
    expect(code).toBe(1);
    expect(calls).toBe(1);
  });

  it('gives up after the bounded attempts if the bind error persists', async () => {
    let calls = 0;
    const code = await runContainerCycle('/root', {
      ...baseOpts,
      devcontainerSpawn: async (_args, _cwd, options) => {
        calls += 1;
        options?.logSink?.write(
          'bind source path does not exist: /host_mnt/x\n',
        );
        return 1;
      },
    });
    expect(code).toBe(1);
    expect(calls).toBe(3);
  });
});

describe('image-mode lifecycle (no compose.yaml)', () => {
  let tmp: string;
  let bare: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'monoceros-image-lifecycle-'));
    bare = path.join(tmp, 'sandbox');
    await fs.mkdir(path.join(bare, '.devcontainer'), { recursive: true });
    // deliberately no compose.yaml -> image-mode
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('runStop docker-stops the labeled container', async () => {
    const calls: string[][] = [];
    const code = await runStop({
      root: bare,
      logger: { info: () => {} },
      dockerExec: async (args) => {
        calls.push(args);
        return args[0] === 'ps'
          ? { exitCode: 0, stdout: 'abc123\n', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(code).toBe(0);
    expect(calls[0]).toEqual([
      'ps',
      '-q',
      '--filter',
      `label=devcontainer.local_folder=${bare}`,
      '--filter',
      'status=running',
    ]);
    expect(calls[1]).toEqual(['stop', 'abc123']);
  });

  it('runStop is a no-op when nothing is running', async () => {
    const calls: string[][] = [];
    const code = await runStop({
      root: bare,
      logger: { info: () => {} },
      dockerExec: async (args) => {
        calls.push(args);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1); // only the lookup, no `stop`
  });

  it('runStatus prints docker default table for the labeled container', async () => {
    const calls: string[][] = [];
    const code = await runStatus({
      root: bare,
      logger: { info: () => {} },
      dockerExec: async (args) => {
        calls.push(args);
        return {
          exitCode: 0,
          stdout:
            'CONTAINER ID   IMAGE                    STATUS         NAMES\n' +
            'abc123def456   monoceros-runtime:dev    Up 3 minutes   monoceros-sandbox\n',
          stderr: '',
        };
      },
    });
    expect(code).toBe(0);
    // No --format: docker's default table (with header) is rendered.
    expect(calls[0]).toEqual([
      'ps',
      '-a',
      '--filter',
      `label=devcontainer.local_folder=${bare}`,
    ]);
  });

  it('runStatus reports "does not exist" when only the header is returned', async () => {
    const infos: string[] = [];
    const code = await runStatus({
      root: bare,
      logger: { info: (m) => infos.push(m) },
      dockerExec: async () => ({
        exitCode: 0,
        stdout: 'CONTAINER ID   IMAGE   STATUS   NAMES\n',
        stderr: '',
      }),
    });
    expect(code).toBe(0);
    expect(infos.join('\n')).toMatch(
      /does not exist.*monoceros apply sandbox/s,
    );
  });
});
