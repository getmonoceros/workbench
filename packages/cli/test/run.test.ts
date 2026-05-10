import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractInnerCommand,
  runInContainer,
} from '../src/devcontainer/run.js';

const silentLogger = { info: () => {} };

describe('extractInnerCommand', () => {
  it('returns the slice after the first `--`', () => {
    expect(
      extractInnerCommand(['--project=foo', '--', 'ls', '-la', '/tmp']),
    ).toEqual(['ls', '-la', '/tmp']);
  });

  it('returns an empty array when `--` is missing', () => {
    expect(extractInnerCommand(['--project=foo'])).toEqual([]);
  });

  it('returns an empty array when `--` is the last token', () => {
    expect(extractInnerCommand(['--project=foo', '--'])).toEqual([]);
  });
});

describe('runInContainer', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-run-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('throws when no command is provided', async () => {
    await expect(
      runInContainer({
        command: [],
        cwd: root,
        logger: silentLogger,
        spawn: async () => 0,
      }),
    ).rejects.toThrow(/No command provided/);
  });

  it('throws when no .devcontainer/ is found at or above cwd', async () => {
    await expect(
      runInContainer({
        command: ['ls'],
        cwd: root,
        logger: silentLogger,
        spawn: async () => 0,
      }),
    ).rejects.toThrow(/No \.devcontainer\/ found/);
  });

  it('forwards the command verbatim to devcontainer exec', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const calls: string[][] = [];
    const exitCode = await runInContainer({
      command: ['pnpm', 'test', '--filter', 'foo'],
      cwd: solution,
      logger: silentLogger,
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(calls).toEqual([
      ['up', '--workspace-folder', solution],
      [
        'exec',
        '--workspace-folder',
        solution,
        'pnpm',
        'test',
        '--filter',
        'foo',
      ],
    ]);
  });

  it('propagates the inner command exit code', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const exitCode = await runInContainer({
      command: ['false'],
      cwd: solution,
      logger: silentLogger,
      spawn: async (args) => (args[0] === 'up' ? 0 : 42),
    });
    expect(exitCode).toBe(42);
  });

  it('short-circuits and propagates the exit code when up fails', async () => {
    const solution = path.join(root, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const calls: string[][] = [];
    const exitCode = await runInContainer({
      command: ['ls'],
      cwd: solution,
      logger: silentLogger,
      spawn: async (args) => {
        calls.push(args);
        return 9;
      },
    });
    expect(exitCode).toBe(9);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe('up');
  });

  it('honors --project when locating the solution', async () => {
    const solution = path.join(root, 'sibling');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });

    const calls: { args: string[]; cwd: string }[] = [];
    await runInContainer({
      command: ['ls'],
      cwd: elsewhere,
      project: path.relative(elsewhere, solution),
      logger: silentLogger,
      spawn: async (args, cwd) => {
        calls.push({ args, cwd });
        return 0;
      },
    });
    expect(calls[0]?.cwd).toBe(solution);
    expect(calls[1]?.args).toEqual([
      'exec',
      '--workspace-folder',
      solution,
      'ls',
    ]);
  });
});
