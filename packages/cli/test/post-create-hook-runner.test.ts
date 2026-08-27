import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPostCreateScript } from '../src/create/scaffold.js';

/**
 * The hook runner inside the generated `post-create.sh`, executed rather than
 * string-matched (ADR 0054).
 *
 * String assertions cannot see the property that matters here. `post-create.sh`
 * runs under `set -e`, hooks are written by features and by definition fail
 * sometimes — an expired credential, a registry outage — and devcontainer
 * abandons the ENTIRE postCreate sequence on a non-zero exit. So one feature's
 * bad day used to take down every later hook, the feature notes and the
 * workspace dependency install with it. Whether that is still true is a
 * question about how the shell behaves, so the test runs the shell.
 *
 * The ordering assertion is the second half: a login hook belongs to the tool
 * version the builder is about to use, so the refresh pass has to come first.
 */

let dir: string;
let binDir: string;
let workspace: string;
let shareDir: string;
let script: string;
let order: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [script],
      {
        cwd: workspace,
        env: {
          PATH: [binDir, '/usr/bin', '/bin'].join(':'),
          HOME: dir,
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: number }).code === 'number'
            ? (err as { code: number }).code
            : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function stub(name: string, body: string): Promise<void> {
  const file = path.join(binDir, name);
  await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(file, 0o755);
}

/**
 * A hook that appends its name to the order file, then exits with `code`. The
 * order file is how both properties are asserted: which hooks ran at all, and
 * in what sequence.
 */
async function hook(
  where: 'refresh.d' | 'post-create.d',
  name: string,
  code = 0,
): Promise<void> {
  const file = path.join(shareDir, where, `${name}.sh`);
  await writeFile(
    file,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' '${name}' >> ${order}`,
      `exit ${code}`,
    ].join('\n'),
  );
  await chmod(file, 0o755);
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'monoceros-hookrunner-'));
  binDir = path.join(dir, 'bin');
  workspace = path.join(dir, 'workspace');
  shareDir = path.join(dir, 'share');
  order = path.join(dir, 'order');
  for (const d of [
    binDir,
    workspace,
    path.join(shareDir, 'refresh.d'),
    path.join(shareDir, 'post-create.d'),
  ]) {
    await mkdir(d, { recursive: true });
  }

  // git and pnpm are stubbed rather than sandboxed: the script's first act is
  // `git config --global`, and this test has no business touching the real one.
  await stub('git', 'exit 0');
  await stub('pnpm', 'exit 0');

  const generated = buildPostCreateScript({
    name: 'demo',
    languages: [],
    services: [],
  })
    .replaceAll('/usr/local/share/monoceros', shareDir)
    .replaceAll('/workspaces/demo', workspace);
  script = path.join(dir, 'post-create.sh');
  await writeFile(script, generated);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('post-create hook runner', () => {
  it('runs the refresh pass before the login hooks', async () => {
    await hook('refresh.d', 'refresh-one');
    await hook('post-create.d', 'login-one');

    const result = await run();
    expect(result.code).toBe(0);
    expect((await readFile(order, 'utf8')).trim().split('\n')).toEqual([
      'refresh-one',
      'login-one',
    ]);
  });

  it('carries on through a failing refresh hook', async () => {
    await hook('refresh.d', 'a-breaks', 1);
    await hook('refresh.d', 'b-works');

    const result = await run();
    expect(result.code).toBe(0);
    expect((await readFile(order, 'utf8')).trim().split('\n')).toEqual([
      'a-breaks',
      'b-works',
    ]);
    expect(result.stderr).toContain('refresh hook failed: a-breaks.sh');
  });

  it('records a failed refresh hook in the log the builder gets to see', async () => {
    await hook('refresh.d', 'a-breaks', 1);

    await run();
    const log = await readFile(
      path.join(workspace, '.monoceros', 'refresh.log'),
      'utf8',
    );
    expect(log).toContain('a-breaks: could not check for updates');
  });

  it('carries on through a failing login hook, and still writes the notes', async () => {
    await hook('post-create.d', 'a-breaks', 1);
    await hook('post-create.d', 'b-works');
    // A note left by a feature at build time. Before ADR 0054 an earlier hook
    // failing meant this never reached the workspace, so the builder lost the
    // one channel that explains what the feature decided.
    await mkdir(path.join(shareDir, 'notes.d'), { recursive: true });
    await writeFile(
      path.join(shareDir, 'notes.d', 'somefeature.txt'),
      'held at 13.0.0 by the engine range\n',
    );

    const result = await run();
    expect(result.code).toBe(0);
    expect((await readFile(order, 'utf8')).trim().split('\n')).toEqual([
      'a-breaks',
      'b-works',
    ]);
    expect(result.stderr).toContain('post-create hook failed: a-breaks.sh');
    expect(
      await readFile(
        path.join(workspace, '.monoceros', 'notes', 'somefeature.txt'),
        'utf8',
      ),
    ).toContain('held at 13.0.0');
  });

  it('clears the refresh log, so it always describes the apply just run', async () => {
    const log = path.join(workspace, '.monoceros', 'refresh.log');
    await mkdir(path.dirname(log), { recursive: true });
    await writeFile(log, 'claude 1.0.0 (updated from 0.9.0)\n');

    await hook('refresh.d', 'quiet-hook');
    await run();

    // The hook wrote nothing, so a leftover line from a previous apply would
    // now be reported as this apply's result.
    expect(existsSync(log)).toBe(false);
  });

  it('is a no-op when a container has no hooks at all', async () => {
    const result = await run();
    expect(result.code).toBe(0);
    expect(existsSync(order)).toBe(false);
  });
});
