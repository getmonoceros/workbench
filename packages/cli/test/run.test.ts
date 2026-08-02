import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wrapExec } from '../src/devcontainer/browser-bridge.js';
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
      {
        args: [
          'up',
          '--workspace-folder',
          solution,
          '--mount-workspace-git-root=false',
        ],
        quiet: true,
      },
      {
        args: [
          'exec',
          '--workspace-folder',
          solution,
          '--mount-workspace-git-root=false',
          'pnpm',
          'test',
          '--filter',
          'foo',
        ],
        quiet: false,
      },
    ]);
  });

  // The first run for a new app hits a directory the agent has not created
  // yet. It used to die on bash's `cd: …: No such file or directory`, which
  // is both the wrong answer and no help. Starting one level up is not a
  // substitute: language servers look for their markers in the directory
  // they were started in.
  it('offers to create a missing --in directory and then uses it', async () => {
    const solution = path.join(tmp, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const calls: string[][] = [];
    let asked = '';
    const exitCode = await runInContainer({
      command: ['opencode'],
      cwd: 'projects/shop',
      root: solution,
      confirm: async (dir) => {
        asked = dir;
        return true;
      },
      // `test -d` fails, everything else succeeds.
      spawn: async (args) => {
        calls.push(args);
        return args.includes('test') ? 1 : 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(asked).toBe('projects/shop');
    expect(calls.some((c) => c.includes('mkdir') && c.includes('-p'))).toBe(
      true,
    );
    expect(calls[calls.length - 1]?.join(' ')).toContain('cd --');
  });

  it('stops with a Monoceros error when the answer is no', async () => {
    const solution = path.join(tmp, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const calls: string[][] = [];
    await expect(
      runInContainer({
        command: ['opencode'],
        cwd: 'projects/shop',
        root: solution,
        confirm: async () => false,
        spawn: async (args) => {
          calls.push(args);
          return args.includes('test') ? 1 : 0;
        },
      }),
    ).rejects.toThrow(/does not exist in the container.*--yes/s);
    expect(calls.some((c) => c.includes('mkdir'))).toBe(false);
  });

  it('creates without asking when yes is set', async () => {
    const solution = path.join(tmp, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const calls: string[][] = [];
    const exitCode = await runInContainer({
      command: ['opencode'],
      cwd: 'projects/shop',
      root: solution,
      yes: true,
      confirm: async () => {
        throw new Error('must not ask when --yes is set');
      },
      spawn: async (args) => {
        calls.push(args);
        return args.includes('test') ? 1 : 0;
      },
    });
    expect(exitCode).toBe(0);
    expect(calls.some((c) => c.includes('mkdir'))).toBe(true);
  });

  it('wraps the command in a cd shell when cwd is set, keeping inner args separate', async () => {
    const solution = path.join(tmp, 'demo');
    await fs.mkdir(path.join(solution, '.devcontainer'), { recursive: true });
    const calls: string[][] = [];
    const exitCode = await runInContainer({
      command: ['claude', '-p', 'build me a thing'],
      cwd: 'projects',
      root: solution,
      spawn: async (args) => {
        calls.push(args);
        return 0;
      },
    });
    expect(exitCode).toBe(0);
    // up, then the `test -d` for the cwd, then the wrapped exec.
    expect(calls[calls.length - 1]).toEqual([
      'exec',
      '--workspace-folder',
      solution,
      '--mount-workspace-git-root=false',
      'bash',
      '-lc',
      'cd -- "$1" && shift && exec "$@"',
      'bash',
      'projects',
      'claude',
      '-p',
      'build me a thing',
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

describe('wrapExec', () => {
  const cmd = ['claude', 'auth', 'login'];

  it('returns the command unchanged when neither pathPrepend nor cwd is set', () => {
    expect(wrapExec(cmd, {})).toEqual(cmd);
  });

  it('wraps for cwd only (keeps the inner args separate)', () => {
    expect(wrapExec(cmd, { cwd: 'projects' })).toEqual([
      'bash',
      '-lc',
      'cd -- "$1" && shift && exec "$@"',
      'bash',
      'projects',
      ...cmd,
    ]);
  });

  it('wraps for the browser-bridge PATH prepend only', () => {
    expect(
      wrapExec(cmd, { pathPrepend: '/workspaces/x/.monoceros-bridge' }),
    ).toEqual([
      'bash',
      '-lc',
      'export PATH="$1:$PATH" && export BROWSER="$1/xdg-open" && shift && exec "$@"',
      'bash',
      '/workspaces/x/.monoceros-bridge',
      ...cmd,
    ]);
  });

  it('wraps for both PATH prepend and cwd (order: PATH, then cd, shift 2)', () => {
    expect(
      wrapExec(cmd, {
        pathPrepend: '/workspaces/x/.monoceros-bridge',
        cwd: 'projects',
      }),
    ).toEqual([
      'bash',
      '-lc',
      'export PATH="$1:$PATH" && export BROWSER="$1/xdg-open" && cd -- "$2" && shift 2 && exec "$@"',
      'bash',
      '/workspaces/x/.monoceros-bridge',
      'projects',
      ...cmd,
    ]);
  });
});
