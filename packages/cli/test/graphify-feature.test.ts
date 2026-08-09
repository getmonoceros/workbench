import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The graphify feature, exercised as real processes: its install.sh, and the
 * post-create hook that script generates.
 *
 * Four properties are worth a test, and each one has a concrete way to break.
 * The launcher must be reachable from a NON-login shell, because ~/.local/bin
 * only lands on PATH via Debian's ~/.profile, which a `docker exec … bash` and
 * every `sh -c` an agent spawns never source. The hook must derive its
 * platforms from the agents actually installed, since `graphify install` takes
 * one platform per call and rejects a second value. It must survive a failing
 * registration, because devcontainer's postCreate skips every remaining hook -
 * other features' included - on a non-zero exit. And the two builder-supplied
 * options end up inside a shell command, so a bogus value has to be rejected
 * rather than expanded.
 */

const INSTALL_SH = fileURLToPath(
  new URL('../../../components/features/graphify/install.sh', import.meta.url),
);

let dir: string;
let binDir: string;
let postCreate: string;
let installer: string;
let hook: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * PATH is built from the sandbox plus the two system directories the scripts
 * need (cut, mkdir, ln), and deliberately NOT from the host's PATH: the agents
 * the hook detects with `command -v` are exactly the CLIs a developer machine
 * has installed, so an inherited PATH would let the host decide the outcome.
 */
function run(
  file: string,
  env: Record<string, string> = {},
  pathPrefix: string[] = [],
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [file],
      {
        env: {
          PATH: [...pathPrefix, binDir, '/usr/bin', '/bin'].join(':'),
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

/** A stub executable in `where` (defaults to the shared stub dir). */
async function stub(name: string, body: string, where = binDir): Promise<void> {
  const file = path.join(where, name);
  await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(file, 0o755);
}

/** Run the feature's install.sh in the sandbox, with the given options. */
async function install(env: Record<string, string> = {}): Promise<Run> {
  return run(installer, env);
}

beforeEach(async () => {
  // realpath, because the hook is asserted on the directory it stands in and
  // macOS hands out /var/… for a /private/var/… temp dir.
  dir = await realpath(
    await mkdtemp(path.join(tmpdir(), 'monoceros-graphify-')),
  );
  binDir = path.join(dir, 'bin');
  postCreate = path.join(dir, 'post-create.d');
  await mkdir(binDir, { recursive: true });

  // The uv tool venv the install links to. Present so the symlink install.sh
  // creates actually resolves — a dangling one is exactly what its own PATH
  // check is there to catch.
  const toolBin = path.join(
    dir,
    '.local',
    'share',
    'uv',
    'tools',
    'graphifyy',
    'bin',
  );
  await mkdir(toolBin, { recursive: true });
  await stub('graphify', 'echo "graphify 0.9.37"', toolBin);

  await stub('uv', 'echo "uv 0.12.3 (stub)" >&2; echo "$@" >> "$RECORD_UV"');
  await stub('getent', `echo "node:x:1000:1000::${dir}:/bin/bash"`);
  // `runuser -u node -- bash -lc '<cmd>'`: drop the first three arguments and
  // run the rest, so the install's real command line is what executes.
  await stub('runuser', 'shift 3; exec "$@"');
  await stub('curl', 'exit 0');

  const src = await readFile(INSTALL_SH, 'utf8');
  const patched = src
    .replaceAll('/usr/local/bin/graphify', path.join(binDir, 'graphify'))
    .replaceAll('/usr/local/share/monoceros/post-create.d', postCreate);
  installer = path.join(dir, 'install.sh');
  await writeFile(installer, patched);
  hook = path.join(postCreate, 'graphify-skill.sh');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('install.sh', () => {
  it('installs the default extras as one spec and leaves the launcher on the system PATH', async () => {
    const record = path.join(dir, 'uv.log');
    const result = await install({
      EXTRAS: 'sql,pdf,leiden',
      RECORD_UV: record,
    });
    expect(result.code).toBe(0);

    // One spec, and pinned to the interpreter the base image already has: uv
    // would otherwise download a second Python, and `leiden` is not
    // installable above 3.12.
    const uv = await readFile(record, 'utf8');
    expect(uv).toContain(
      'tool install --python python3.11 graphifyy[sql,pdf,leiden]',
    );

    // The proof that matters is a NON-login shell, which never sources
    // ~/.profile and so never sees ~/.local/bin.
    const probe = path.join(dir, 'probe.sh');
    await writeFile(probe, 'graphify --version\n');
    const onPath = await run(probe);
    expect(onPath.code).toBe(0);
    expect(onPath.stdout).toContain('graphify 0.9.37');
  });

  it('installs the bare package when extras are emptied', async () => {
    const record = path.join(dir, 'uv.log');
    const result = await install({ EXTRAS: '', RECORD_UV: record });
    expect(result.code).toBe(0);
    const uv = await readFile(record, 'utf8');
    expect(uv).toContain('graphifyy');
    expect(uv).not.toContain('[');
  });

  it('appends a version specifier to the spec, and floats on `latest`', async () => {
    const pinned = path.join(dir, 'uv-pinned.log');
    expect(
      (await install({ VERSION: '==0.9.37', EXTRAS: 'sql', RECORD_UV: pinned }))
        .code,
    ).toBe(0);
    expect(await readFile(pinned, 'utf8')).toContain('graphifyy[sql]==0.9.37');

    const floating = path.join(dir, 'uv-latest.log');
    expect(
      (await install({ VERSION: 'latest', EXTRAS: 'sql', RECORD_UV: floating }))
        .code,
    ).toBe(0);
    expect(await readFile(floating, 'utf8')).toContain('graphifyy[sql]');
    expect(await readFile(floating, 'utf8')).not.toContain('latest');
  });

  it('rejects an extras value that is not a list of names', async () => {
    const record = path.join(dir, 'uv.log');
    const result = await install({
      EXTRAS: "sql'; touch /tmp/pwned; echo '",
      RECORD_UV: record,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('comma-separated lowercase names');
  });

  it('rejects a version that is not a PEP 440 specifier', async () => {
    const result = await install({
      VERSION: '0.9.37 && whoami',
      RECORD_UV: path.join(dir, 'uv.log'),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PEP 440 specifier');
  });
});

describe('the post-create hook', () => {
  let hookBin: string;
  let record: string;

  beforeEach(async () => {
    expect((await install({ RECORD_UV: path.join(dir, 'uv.log') })).code).toBe(
      0,
    );
    hookBin = path.join(dir, 'hook-bin');
    record = path.join(dir, 'graphify.log');
    await mkdir(hookBin, { recursive: true });
    await stub('graphify', `echo "$@" >> "${record}"`, hookBin);
  });

  const runHook = (): Promise<Run> => run(hook, {}, [hookBin]);

  it('registers exactly the agents present in the container', async () => {
    await stub('claude', 'exit 0', hookBin);
    await stub('opencode', 'exit 0', hookBin);

    const result = await runHook();
    expect(result.code).toBe(0);

    // One call per platform: `graphify install` rejects a second value.
    const calls = (await readFile(record, 'utf8')).trim().split('\n');
    expect(calls).toEqual([
      'install --platform claude',
      'install --platform opencode',
    ]);
  });

  it('registers only the agent that is there', async () => {
    await stub('opencode', 'exit 0', hookBin);
    expect((await runHook()).code).toBe(0);
    expect((await readFile(record, 'utf8')).trim()).toBe(
      'install --platform opencode',
    );
  });

  it('is a no-op without an agent, which is the console builder', async () => {
    const result = await runHook();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no AI agent in this container');
    await expect(readFile(record, 'utf8')).rejects.toThrow();
  });

  it('never fails the post-create over a registration that broke', async () => {
    await stub('claude', 'exit 0', hookBin);
    await stub(
      'graphify',
      'echo "error: unknown platform" >&2; exit 1',
      hookBin,
    );

    const result = await runHook();
    // A non-zero exit here would skip every remaining post-create hook,
    // other features' included.
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('the CLI works');
  });

  it('registers from $HOME, so a "global" opencode install cannot litter the workspace', async () => {
    await stub('opencode', 'exit 0', hookBin);
    // graphify writes .opencode/ into the CURRENT directory even without
    // --project, so where the hook stands is the whole guard.
    await stub('graphify', `pwd >> "${record}"`, hookBin);
    expect((await runHook()).code).toBe(0);
    expect((await readFile(record, 'utf8')).trim()).toBe(dir);
  });
});
