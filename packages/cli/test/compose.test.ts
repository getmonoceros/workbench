import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveCompose,
  runLogs,
  runStart,
  runStatus,
  runStop,
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
      { args: ['up', '--workspace-folder', solution], cwd: solution },
    ]);
  });

  it('runStart refuses without compose.yaml', async () => {
    const bare = path.join(tmp, 'image-only');
    await fs.mkdir(path.join(bare, '.devcontainer'), { recursive: true });
    await expect(
      runStart({
        root: bare,
        logger: { info: () => {} },
        spawn: async () => 0,
      }),
    ).rejects.toThrow(/require services configured/);
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
