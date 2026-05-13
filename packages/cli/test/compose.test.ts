import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveCompose,
  runApply,
  runDown,
  runLogs,
  runStart,
  runStatus,
  runStop,
} from '../src/devcontainer/compose.js';

describe('resolveCompose', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-compose-resolve-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('throws when no .devcontainer/ is found at or above cwd', () => {
    expect(() => resolveCompose(root, undefined)).toThrow(
      /No \.devcontainer\/ found/,
    );
  });

  it('throws with a guiding message when compose.yaml is missing', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    expect(() => resolveCompose(solution, undefined)).toThrow(
      /No compose\.yaml at/,
    );
  });

  it('returns the solution root and absolute compose path', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    await fs.writeFile(
      path.join(solution, '.devcontainer', 'compose.yaml'),
      'services: {}\n',
    );
    expect(resolveCompose(solution, undefined)).toEqual({
      root: solution,
      composeFile: path.join(solution, '.devcontainer', 'compose.yaml'),
      projectName: 'demo_devcontainer',
    });
  });
});

describe('compose actions', () => {
  let root: string;
  let solution: string;
  let composeFile: string;
  const projectName = 'demo_devcontainer';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-compose-action-'));
    solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    composeFile = path.join(solution, '.devcontainer', 'compose.yaml');
    await fs.writeFile(composeFile, 'services: {}\n');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('runStart delegates to `devcontainer up` with the workspace folder', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const exitCode = await runStart({
      cwd: solution,
      logger: { info: () => {} },
      spawn: async (args, cwd) => {
        calls.push({ args, cwd });
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      {
        args: ['up', '--workspace-folder', solution],
        cwd: solution,
      },
    ]);
  });

  it('runStart refuses without compose.yaml', async () => {
    const bare = path.join(root, 'image-only');
    await fs.mkdir(path.join(bare, '.devcontainer'), { recursive: true });
    await expect(
      runStart({
        cwd: bare,
        logger: { info: () => {} },
        spawn: async () => 0,
      }),
    ).rejects.toThrow(/only meaningful with services/);
  });

  it('runDown removes containers and network without volumes by default', async () => {
    const calls: string[][] = [];
    await runDown({
      cwd: solution,
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(calls).toEqual([['-f', composeFile, '-p', projectName, 'down']]);
  });

  it('runDown with volumes=true appends -v', async () => {
    const calls: string[][] = [];
    await runDown({
      cwd: solution,
      volumes: true,
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(calls).toEqual([
      ['-f', composeFile, '-p', projectName, 'down', '-v'],
    ]);
  });

  it('runStop issues `stop` and preserves volumes', async () => {
    const calls: string[][] = [];
    await runStop({
      cwd: solution,
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
      cwd: solution,
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
      cwd: solution,
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
      cwd: solution,
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
      cwd: solution,
      service: 'postgres',
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    await runLogs({
      cwd: solution,
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
      cwd: solution,
      spawn: async () => 5,
    });
    expect(exitCode).toBe(5);
  });

  it('honors --project when locating the solution', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    const calls: { cwd: string; args: string[] }[] = [];
    await runStatus({
      cwd: elsewhere,
      project: path.relative(elsewhere, solution),
      spawn: async (args, cwd) => {
        calls.push({ args, cwd });
        return 0;
      },
    });
    expect(calls[0]?.cwd).toBe(solution);
    expect(calls[0]?.args).toContain(composeFile);
  });
});

describe('runApply', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-apply-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('compose-mode: runs docker compose down (no -v) then devcontainer up', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const composeFile = path.join(solution, '.devcontainer', 'compose.yaml');
    await fs.writeFile(composeFile, 'services: {}\n');

    const composeCalls: string[][] = [];
    const devcontainerCalls: { args: string[]; cwd: string }[] = [];

    const exitCode = await runApply({
      cwd: solution,
      logger: { info: () => {} },
      dockerComposeSpawn: async (args) => {
        composeCalls.push(args);
        return 0;
      },
      devcontainerSpawn: async (args, cwd) => {
        devcontainerCalls.push({ args, cwd });
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(composeCalls).toEqual([
      ['-f', composeFile, '-p', 'demo_devcontainer', 'down'],
    ]);
    expect(devcontainerCalls).toEqual([
      { args: ['up', '--workspace-folder', solution], cwd: solution },
    ]);
  });

  it('compose-mode: short-circuits if down fails (skips devcontainer up)', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    await fs.writeFile(
      path.join(solution, '.devcontainer', 'compose.yaml'),
      'services: {}\n',
    );

    const devcontainerCalls: { args: string[] }[] = [];

    const exitCode = await runApply({
      cwd: solution,
      logger: { info: () => {} },
      dockerComposeSpawn: async () => 7,
      devcontainerSpawn: async (args) => {
        devcontainerCalls.push({ args });
        return 0;
      },
    });

    expect(exitCode).toBe(7);
    expect(devcontainerCalls).toEqual([]);
  });

  it('image-mode: calls devcontainer up with --remove-existing-container', async () => {
    const solution = path.join(root, 'bare');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    // No compose.yaml — image mode.

    const composeCalls: string[][] = [];
    const devcontainerCalls: { args: string[]; cwd: string }[] = [];

    const exitCode = await runApply({
      cwd: solution,
      logger: { info: () => {} },
      dockerComposeSpawn: async (args) => {
        composeCalls.push(args);
        return 0;
      },
      devcontainerSpawn: async (args, cwd) => {
        devcontainerCalls.push({ args, cwd });
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(composeCalls).toEqual([]);
    expect(devcontainerCalls).toEqual([
      {
        args: [
          'up',
          '--workspace-folder',
          solution,
          '--remove-existing-container',
        ],
        cwd: solution,
      },
    ]);
  });

  it('throws when no .devcontainer/ exists at or above cwd', async () => {
    await expect(
      runApply({
        cwd: root,
        logger: { info: () => {} },
        dockerComposeSpawn: async () => 0,
        devcontainerSpawn: async () => 0,
      }),
    ).rejects.toThrow(/No \.devcontainer\/ found/);
  });

  it('honors --project to locate the solution from elsewhere', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    // Image mode (no compose.yaml) — simpler call shape.

    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });

    const devcontainerCalls: { args: string[]; cwd: string }[] = [];
    await runApply({
      cwd: elsewhere,
      project: path.relative(elsewhere, solution),
      logger: { info: () => {} },
      devcontainerSpawn: async (args, cwd) => {
        devcontainerCalls.push({ args, cwd });
        return 0;
      },
    });

    expect(devcontainerCalls[0]?.cwd).toBe(solution);
    expect(devcontainerCalls[0]?.args).toContain('--remove-existing-container');
  });
});
