import { existsSync, promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cloneReposHostSide,
  formatCloneFailuresError,
  type CloneSpawn,
} from '../src/devcontainer/repo-clone.js';

describe('cloneReposHostSide', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-clone-'));
    await fs.mkdir(path.join(root, 'projects'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('clones a repo into projects/<path> and reports cloned', async () => {
    const calls: Array<{ url: string; dest: string }> = [];
    const spawn: CloneSpawn = async (url, dest) => {
      calls.push({ url, dest });
      await fs.mkdir(dest, { recursive: true });
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const results = await cloneReposHostSide(
      root,
      [{ url: 'https://github.com/foo/bar.git', path: 'bar' }],
      { spawn },
    );
    expect(results).toEqual([
      { path: 'bar', url: 'https://github.com/foo/bar.git', status: 'cloned' },
    ]);
    expect(calls[0]!.dest).toBe(path.join(root, 'projects', 'bar'));
  });

  it('skips an existing projects/<path> without invoking git', async () => {
    await fs.mkdir(path.join(root, 'projects', 'bar'), { recursive: true });
    let called = false;
    const spawn: CloneSpawn = async () => {
      called = true;
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const results = await cloneReposHostSide(
      root,
      [{ url: 'https://github.com/foo/bar.git', path: 'bar' }],
      { spawn },
    );
    expect(called).toBe(false);
    expect(results[0]!.status).toBe('skipped');
  });

  it('creates parent dirs for a nested path', async () => {
    const spawn: CloneSpawn = async (_url, dest) => {
      // parent must already exist when git would run
      expect(existsSync(path.dirname(dest))).toBe(true);
      await fs.mkdir(dest, { recursive: true });
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const results = await cloneReposHostSide(
      root,
      [{ url: 'https://github.com/foo/web.git', path: 'apps/web' }],
      { spawn },
    );
    expect(results[0]!.status).toBe('cloned');
  });

  it('reports a non-zero git exit as failed with stderr detail', async () => {
    const spawn: CloneSpawn = async () => ({
      stdout: '',
      stderr: 'fatal: could not read from remote',
      exitCode: 128,
    });
    const results = await cloneReposHostSide(
      root,
      [{ url: 'https://github.com/foo/bar.git', path: 'bar' }],
      { spawn },
    );
    expect(results[0]!.status).toBe('failed');
    expect(formatCloneFailuresError(results)).toMatch(/Failed to clone/);
  });
});
