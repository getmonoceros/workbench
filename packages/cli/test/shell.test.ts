import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSolutionRoot } from '../src/devcontainer/locate.js';
import { runShell } from '../src/devcontainer/shell.js';

const silentLogger = { info: () => {} };

describe('findSolutionRoot', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-shell-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns null when no .devcontainer/ exists in any parent', async () => {
    const nested = path.join(root, 'a', 'b', 'c');
    await fs.mkdir(nested, { recursive: true });
    expect(findSolutionRoot(nested)).toBeNull();
  });

  it('returns the directory that holds .devcontainer/', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    expect(findSolutionRoot(solution)).toBe(solution);
  });

  it('walks up to find an ancestor containing .devcontainer/', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const deeper = path.join(solution, 'src', 'nested');
    await fs.mkdir(deeper, { recursive: true });
    expect(findSolutionRoot(deeper)).toBe(solution);
  });
});

describe('runShell', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-shell-run-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('throws when no .devcontainer/ is found at or above cwd', async () => {
    await expect(
      runShell({ cwd: root, logger: silentLogger, spawn: async () => 0 }),
    ).rejects.toThrow(/No \.devcontainer\/ found/);
  });

  it('invokes devcontainer up then exec bash with the workspace folder', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const calls: { args: string[]; cwd: string }[] = [];
    const exitCode = await runShell({
      cwd: solution,
      logger: silentLogger,
      spawn: async (args, cwd) => {
        calls.push({ args, cwd });
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      { args: ['up', '--workspace-folder', solution], cwd: solution },
      {
        args: ['exec', '--workspace-folder', solution, 'bash'],
        cwd: solution,
      },
    ]);
  });

  it('short-circuits and propagates the exit code when up fails', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const calls: string[][] = [];
    const exitCode = await runShell({
      cwd: solution,
      logger: silentLogger,
      spawn: async (args) => {
        calls.push(args);
        return 7;
      },
    });
    expect(exitCode).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('up');
  });

  it('honors --project when locating the solution', async () => {
    const solution = path.join(root, 'sibling');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });

    const calls: { args: string[]; cwd: string }[] = [];
    await runShell({
      cwd: elsewhere,
      project: path.relative(elsewhere, solution),
      logger: silentLogger,
      spawn: async (args, cwd) => {
        calls.push({ args, cwd });
        return 0;
      },
    });
    expect(calls[0]?.cwd).toBe(solution);
    expect(calls[0]?.args).toContain(solution);
  });
});
