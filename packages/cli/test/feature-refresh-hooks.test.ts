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
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatRefreshLog, readRefreshLog } from '../src/create/refresh-log.js';

/**
 * The refresh hooks (ADR 0054), exercised as real processes: the install.sh
 * that writes them, and the hook itself.
 *
 * What these tests are here to stop is a regression that has already cost us
 * once, in the other direction: a container that comes back from an apply with
 * older tooling than it had before, silently. The properties that prevent that
 * are all in shell, so they are tested by running the shell.
 *
 * Four of them matter enough to pin. A pinned version in the yml must suppress
 * the hook entirely, because that pin is the builder's decision and an apply
 * does not overrule it. The check must be a check, not a blind reinstall, or
 * every apply pays a download. A hook must never fail, whatever the registry
 * or the network does, because devcontainer's postCreate takes the whole
 * sequence down with a non-zero exit. And the rate-limited hooks (the tools
 * with no version endpoint) must actually rate-limit, or "once a day" quietly
 * becomes "every apply".
 */

const CLAUDE_INSTALL_SH = fileURLToPath(
  new URL(
    '../../../components/features/claude-code/install.sh',
    import.meta.url,
  ),
);
const ATLASSIAN_INSTALL_SH = fileURLToPath(
  new URL('../../../components/features/atlassian/install.sh', import.meta.url),
);

let dir: string;
let binDir: string;
let refreshDir: string;
let postCreateDir: string;
let profileDir: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * PATH is the sandbox plus the two system dirs the scripts need, and
 * deliberately not the host's: `command -v` probes must see what the test put
 * there, not what this machine happens to have installed.
 */
function run(
  file: string,
  env: Record<string, string> = {},
  args: string[] = [],
): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [file, ...args],
      {
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

/** Redirect every absolute path an installer writes to into the sandbox. */
async function sandboxInstaller(source: string): Promise<string> {
  const src = await readFile(source, 'utf8');
  const patched = src
    .replaceAll('/usr/local/share/monoceros/refresh.d', refreshDir)
    .replaceAll('/usr/local/share/monoceros/post-create.d', postCreateDir)
    .replaceAll(
      '/usr/local/share/monoceros/rovodev-billing-site.py',
      path.join(dir, 'billing-site.py'),
    )
    .replaceAll('/etc/profile.d', profileDir);
  const file = path.join(dir, path.basename(source));
  await writeFile(file, patched);
  return file;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'monoceros-refresh-'));
  binDir = path.join(dir, 'bin');
  refreshDir = path.join(dir, 'refresh.d');
  postCreateDir = path.join(dir, 'post-create.d');
  profileDir = path.join(dir, 'profile.d');
  for (const d of [binDir, refreshDir, postCreateDir, profileDir]) {
    await mkdir(d, { recursive: true });
  }
  // `runuser -u node -- bash -lc '<cmd>'` → run the command itself, so the
  // installer's real command line is what executes.
  //
  // Deliberately re-invoked as `bash -c`, not `exec "$@"`: `-lc` is a LOGIN
  // shell, and on macOS /etc/profile runs path_helper, which rebuilds PATH and
  // drops the sandbox stub dir off the front of it. The installer would then
  // reach the host's real npm — a test that installs Claude Code onto the
  // machine running it. The command line under test is unchanged either way.
  await stub('runuser', 'shift 3; exec bash -c "$3"');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('claude-code refresh hook', () => {
  /** Install the feature, returning the generated hook path. */
  async function installFeature(version = 'latest'): Promise<string> {
    await stub('npm', 'exit 0');
    await stub('claude', 'echo "2.1.240 (Claude Code)"');
    const installer = await sandboxInstaller(CLAUDE_INSTALL_SH);
    const result = await run(installer, { VERSION: version });
    expect(result.code).toBe(0);
    return path.join(refreshDir, 'claude-code.sh');
  }

  /**
   * Stub npm so `view` answers with `latest` and `install` records its
   * arguments. One stub for both, because the hook calls them on the same
   * binary and a test that split them could not catch the hook calling the
   * wrong one.
   */
  async function stubNpm(latest: string, installExit = 0): Promise<string> {
    const log = path.join(dir, 'npm.log');
    await stub(
      'npm',
      [
        `printf '%s\\n' "$*" >> ${log}`,
        'if [ "$1" = "view" ]; then',
        `  printf '%s\\n' '${latest}'`,
        '  exit 0',
        'fi',
        `exit ${installExit}`,
      ].join('\n'),
    );
    return log;
  }

  it('is not written at all when the builder pinned a version', async () => {
    const hook = await installFeature('2.1.240');
    expect(existsSync(hook)).toBe(false);
  });

  it('installs the published version when it differs from the installed one', async () => {
    const hook = await installFeature();
    const npmLog = await stubNpm('2.1.247');
    await stub('claude', 'echo "2.1.240 (Claude Code)"');
    const log = path.join(dir, 'refresh.log');

    const result = await run(hook, { MONOCEROS_REFRESH_LOG: log });
    expect(result.code).toBe(0);

    const calls = await readFile(npmLog, 'utf8');
    expect(calls).toContain('view @anthropic-ai/claude-code version');
    expect(calls).toContain(
      'install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.247',
    );
    expect(await readFile(log, 'utf8')).toContain(
      'claude 2.1.247 (updated from 2.1.240)',
    );
  });

  it('does not install when the installed version is already the published one', async () => {
    const hook = await installFeature();
    const npmLog = await stubNpm('2.1.240');
    await stub('claude', 'echo "2.1.240 (Claude Code)"');
    const log = path.join(dir, 'refresh.log');

    expect((await run(hook, { MONOCEROS_REFRESH_LOG: log })).code).toBe(0);

    // The whole point of the version check: the common case costs one lookup
    // and no download.
    const calls = await readFile(npmLog, 'utf8');
    expect(calls).toContain('view');
    expect(calls).not.toContain('install');
    expect(await readFile(log, 'utf8')).toContain(
      'claude 2.1.240 (already current)',
    );
  });

  it('succeeds and keeps the image version when the registry is unreachable', async () => {
    const hook = await installFeature();
    // `npm view` fails and prints nothing, the way it does without a network.
    await stub('npm', 'exit 1');
    await stub('claude', 'echo "2.1.240 (Claude Code)"');
    const log = path.join(dir, 'refresh.log');

    const result = await run(hook, { MONOCEROS_REFRESH_LOG: log });
    // Exit 0 is the contract: a non-zero exit here aborts devcontainer's whole
    // postCreate sequence, taking every later hook down with it.
    expect(result.code).toBe(0);
    expect(await readFile(log, 'utf8')).toContain(
      'claude: could not reach the npm registry, keeping 2.1.240',
    );
  });

  it('succeeds and says so when the install itself fails', async () => {
    const hook = await installFeature();
    await stubNpm('2.1.247', 1);
    await stub('claude', 'echo "2.1.240 (Claude Code)"');
    const log = path.join(dir, 'refresh.log');

    expect((await run(hook, { MONOCEROS_REFRESH_LOG: log })).code).toBe(0);
    expect(await readFile(log, 'utf8')).toContain(
      'claude: update to 2.1.247 failed, keeping 2.1.240',
    );
  });

  it('survives a --version format it cannot parse', async () => {
    const hook = await installFeature();
    await stubNpm('2.1.247');
    await stub('claude', 'echo "some new banner without a version"');
    const log = path.join(dir, 'refresh.log');

    expect((await run(hook, { MONOCEROS_REFRESH_LOG: log })).code).toBe(0);
    // Unparseable reads as "different", so it installs rather than skipping —
    // the safe direction: an extra install costs seconds, a wrong skip costs
    // the builder the update.
    expect(await readFile(path.join(dir, 'npm.log'), 'utf8')).toContain(
      'install -g',
    );
  });
});

describe('atlassian twg refresh hook', () => {
  /**
   * The twg branch of the atlassian installer, with the build-time download
   * stubbed. Only `twg` is enabled: rovodev and forge have their own tests and
   * would only add stubs here.
   */
  async function installFeature(): Promise<string> {
    const downloaded = path.join(dir, 'twg-install.sh');
    await stub('dpkg', 'echo arm64');
    await stub('mktemp', `echo ${downloaded}`);
    await stub(
      'curl',
      `printf '#!/usr/bin/env bash\\nexit 0\\n' > ${downloaded}`,
    );
    await stub('twg', 'echo "twg 1.4.0"');
    await stub('sudo', 'shift 0; exec "$@"');

    const installer = await sandboxInstaller(ATLASSIAN_INSTALL_SH);
    const result = await run(installer, {
      ROVODEV: 'false',
      TWG: 'true',
      FORGE: 'false',
      INSTANCE: 'example.atlassian.net',
      EMAIL: 'someone@example.com',
      APITOKEN: 'token',
    });
    expect(result.code).toBe(0);
    return path.join(refreshDir, 'atlassian-twg.sh');
  }

  it('runs the installer the first time and skips it again within the day', async () => {
    const hook = await installFeature();
    const log = path.join(dir, '.monoceros', 'refresh.log');
    await mkdir(path.dirname(log), { recursive: true });

    const runs = path.join(dir, 'installer-runs');
    const downloaded = path.join(dir, 'twg-install.sh');
    await stub('mktemp', `echo ${downloaded}`);
    await stub(
      'curl',
      `printf '#!/usr/bin/env bash\\nprintf x >> ${runs}\\n' > ${downloaded}`,
    );

    expect((await run(hook, { MONOCEROS_REFRESH_LOG: log })).code).toBe(0);
    expect((await readFile(runs, 'utf8')).length).toBe(1);
    expect(await readFile(log, 'utf8')).toContain('twg 1.4.0');

    // Second apply on the same day: the stamp next to the refresh log is what
    // makes this cheap, and it lives in the bind-mounted workspace precisely
    // so it outlives the container being recreated.
    expect((await run(hook, { MONOCEROS_REFRESH_LOG: log })).code).toBe(0);
    expect((await readFile(runs, 'utf8')).length).toBe(1);
    expect(await readFile(log, 'utf8')).toContain(
      'twg 1.4.0 (checked within the last day)',
    );
  });

  it('runs the installer again once the stamp is older than a day', async () => {
    const hook = await installFeature();
    const log = path.join(dir, '.monoceros', 'refresh.log');
    const stamp = path.join(dir, '.monoceros', 'refresh-stamps', 'twg');
    await mkdir(path.dirname(stamp), { recursive: true });
    // Two days back, written the way the hook writes it.
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
    await writeFile(stamp, `${twoDaysAgo}\n`);

    const runs = path.join(dir, 'installer-runs');
    const downloaded = path.join(dir, 'twg-install.sh');
    await stub('mktemp', `echo ${downloaded}`);
    await stub(
      'curl',
      `printf '#!/usr/bin/env bash\\nprintf x >> ${runs}\\n' > ${downloaded}`,
    );

    expect((await run(hook, { MONOCEROS_REFRESH_LOG: log })).code).toBe(0);
    expect((await readFile(runs, 'utf8')).length).toBe(1);
  });

  it('succeeds and keeps the image version when the installer cannot be fetched', async () => {
    const hook = await installFeature();
    const log = path.join(dir, '.monoceros', 'refresh.log');
    await mkdir(path.dirname(log), { recursive: true });
    await stub('curl', 'exit 7');

    expect((await run(hook, { MONOCEROS_REFRESH_LOG: log })).code).toBe(0);
    expect(await readFile(log, 'utf8')).toContain(
      'twg: could not fetch the installer, keeping 1.4.0',
    );
  });

  it('does nothing when there is no refresh log to rate-limit against', async () => {
    const hook = await installFeature();
    const runs = path.join(dir, 'installer-runs');
    const downloaded = path.join(dir, 'twg-install.sh');
    await stub('mktemp', `echo ${downloaded}`);
    await stub(
      'curl',
      `printf '#!/usr/bin/env bash\\nprintf x >> ${runs}\\n' > ${downloaded}`,
    );

    // No MONOCEROS_REFRESH_LOG: nowhere to put the stamp, so a hook that
    // downloaded here would download on every single apply.
    expect((await run(hook)).code).toBe(0);
    expect(existsSync(runs)).toBe(false);
  });
});

/**
 * The reading half: apply has to surface the log, and must not fall over when
 * there is nothing to read. A container with no volatile features leaves no
 * log at all, which is the normal case for a plain language workbench.
 */
describe('readRefreshLog / formatRefreshLog', () => {
  it('reads nothing at all as no lines', async () => {
    expect(await readRefreshLog(dir)).toEqual([]);
  });

  it('drops blank lines and trims, so shell quoting cannot produce empty bullets', async () => {
    await mkdir(path.join(dir, '.monoceros'), { recursive: true });
    await writeFile(
      path.join(dir, '.monoceros', 'refresh.log'),
      '  claude 2.1.247 (already current)  \n\n\ngh 2.60.1 (updated from 2.55.0)\n',
    );
    expect(await readRefreshLog(dir)).toEqual([
      'claude 2.1.247 (already current)',
      'gh 2.60.1 (updated from 2.55.0)',
    ]);
  });

  it('renders one bullet per tool and names upgrade as the other half', () => {
    const out = formatRefreshLog([
      'claude 2.1.247 (already current)',
      'gh 2.60.1 (updated from 2.55.0)',
    ]);
    expect(out).toContain('claude 2.1.247 (already current)');
    expect(out).toContain('gh 2.60.1 (updated from 2.55.0)');
    // Services and the base image move on `upgrade`, and a builder reading
    // "Features refreshed" should not conclude that everything else did too.
    expect(out).toContain('upgrade');
  });
});
