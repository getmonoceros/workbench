import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { cyan } from '../util/format.js';

/**
 * Apply step: clone declared repos **host-side, before `compose up`**.
 *
 * Why host-side and not (only) in post-create: a service can bind-mount
 * a file out of a cloned repo (`projects/app/init.sql` → Postgres'
 * docker-entrypoint-initdb.d). Bind mounts resolve when the container
 * starts; the in-container post-create clone runs *after* the container
 * is up. Cloning on the host first means the file exists at up time, so
 * the mount points at real content instead of an empty dir docker would
 * otherwise auto-create.
 *
 * Idempotent: an existing `projects/<path>/` is left untouched (local
 * changes survive re-apply). The in-container post-create clone keeps
 * its `[ ! -d ]` guard, so it simply skips whatever was cloned here.
 *
 * Auth: uses the host `git` + its credential helper — the exact same
 * path the reachability pre-flight (`git ls-remote`) already exercised,
 * and `collectGitCredentials` has populated the helper by this point.
 */

/** Spawn signature for `git clone <url> <dest>`. Injected by tests. */
export type CloneSpawn = (
  url: string,
  dest: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const realGitClone: CloneSpawn = (url, dest) => {
  return new Promise((resolve, reject) => {
    // GIT_TERMINAL_PROMPT=0 keeps the clone non-interactive; the
    // credential helper still runs (see repo-reachability.ts for why we
    // don't touch GIT_ASKPASS).
    const child = spawn('git', ['clone', '--', url, dest], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      resolve({ stdout, stderr, exitCode: code ?? 0 }),
    );
  });
};

export interface CloneRepoEntry {
  url: string;
  path: string;
}

export interface CloneResult {
  path: string;
  url: string;
  status: 'cloned' | 'skipped' | 'failed';
  /** git stderr on failure. */
  detail?: string;
}

export async function cloneReposHostSide(
  containerRoot: string,
  repos: readonly CloneRepoEntry[],
  options: { spawn?: CloneSpawn } = {},
): Promise<CloneResult[]> {
  const spawnFn = options.spawn ?? realGitClone;
  const results: CloneResult[] = [];
  for (const repo of repos) {
    const dest = path.join(containerRoot, 'projects', repo.path);
    if (existsSync(dest)) {
      results.push({ path: repo.path, url: repo.url, status: 'skipped' });
      continue;
    }
    // Ensure the parent of a nested path (`apps/web`) exists before clone.
    await fs.mkdir(path.dirname(dest), { recursive: true });
    let r: Awaited<ReturnType<CloneSpawn>>;
    try {
      r = await spawnFn(repo.url, dest);
    } catch (err) {
      results.push({
        path: repo.path,
        url: repo.url,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    results.push(
      r.exitCode === 0
        ? { path: repo.path, url: repo.url, status: 'cloned' }
        : {
            path: repo.path,
            url: repo.url,
            status: 'failed',
            detail: r.stderr.trim(),
          },
    );
  }
  return results;
}

export function formatCloneFailuresError(
  failures: readonly CloneResult[],
): string {
  const lines: string[] =
    failures.length === 1
      ? [`Failed to clone declared repo: ${failures[0]!.url}`, '']
      : [`Failed to clone ${failures.length} declared repos:`, ''];
  for (const f of failures) {
    lines.push(`  • ${f.url} → projects/${f.path}`);
    if (f.detail) lines.push(`    ${f.detail}`);
  }
  lines.push('');
  lines.push(
    'Reachability was confirmed earlier, so this is usually a local issue',
  );
  lines.push(
    '(disk space, a leftover non-empty target dir). Fix it and re-run ' +
      cyan('monoceros apply') +
      '.',
  );
  return lines.join('\n');
}
