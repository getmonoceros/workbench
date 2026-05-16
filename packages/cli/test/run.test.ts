import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInContainer } from '../src/devcontainer/run.js';

describe('runInContainer', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'monoceros-run-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('throws when no command is provided', async () => {
    await expect(
      runInContainer({
        command: [],
        root: tmp,
        spawn: async () => 0,
      }),
    ).rejects.toThrow(/No command provided/);
  });

  it('throws when the container root has no .devcontainer/', async () => {
    await expect(
      runInContainer({
        command: ['ls'],
        root: tmp,
        spawn: async () => 0,
      }),
    ).rejects.toThrow(/No \.devcontainer\/ at/);
  });

  it('forwards the command verbatim to devcontainer exec', async () => {
    const solution = path.join(tmp, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const calls: { args: string[]; quiet: boolean }[] = [];
    const exitCode = await runInContainer({
      command: ['pnpm', 'test', '--filter', 'foo'],
      root: solution,
      spawn: async (args, _cwd, options) => {
        calls.push({ args, quiet: options?.quiet === true });
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { args: ['up', '--workspace-folder', solution], quiet: true },
      {
        args: [
          'exec',
          '--workspace-folder',
          solution,
          'pnpm',
          'test',
          '--filter',
          'foo',
        ],
        quiet: false,
      },
    ]);
  });

  it('propagates the inner command exit code', async () => {
    const solution = path.join(tmp, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const exitCode = await runInContainer({
      command: ['false'],
      root: solution,
      spawn: async (args) => (args[0] === 'up' ? 0 : 42),
    });
    expect(exitCode).toBe(42);
  });

  it('short-circuits and propagates the exit code when up fails', async () => {
    const solution = path.join(tmp, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const calls: string[][] = [];
    const exitCode = await runInContainer({
      command: ['ls'],
      root: solution,
      spawn: async (args) => {
        calls.push(args);
        return 9;
      },
    });
    expect(exitCode).toBe(9);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('up');
  });
});
