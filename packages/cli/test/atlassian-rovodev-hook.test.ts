import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The Rovo Dev login hook, exercised as a real process.
 *
 * Two properties are worth a test because a real run cost both of them. Rovo Dev
 * needs its own scoped token, and acli answers a classic one with a bare
 * "authentication failed" — which used to abort the whole apply, because
 * devcontainer's postCreate skips every remaining hook on a non-zero exit. And
 * the token must not be baked into the script: this feature installs behind a
 * layer cache, so a baked value would outlive a rotation.
 *
 * So: run the feature's own install.sh with stubs on PATH, then run the hook it
 * generates.
 */

const INSTALL_SH = fileURLToPath(
  new URL('../../../components/features/atlassian/install.sh', import.meta.url),
);

let dir: string;
let hook: string;
let binDir: string;
let presetScript: string;

/** A stub executable that records its stdin and exits with `code`. */
async function stub(name: string, body: string): Promise<void> {
  const file = path.join(binDir, name);
  await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(file, 0o755);
}

function run(
  file: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [file],
      {
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          HOME: dir,
          ...env,
        },
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: number }).code === 'number'
            ? (err as { code: number }).code
            : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'monoceros-rovodev-'));
  binDir = path.join(dir, 'bin');
  const postCreate = path.join(dir, 'post-create.d');
  const refreshDir = path.join(dir, 'refresh.d');
  await mkdir(binDir, { recursive: true });
  await mkdir(postCreate, { recursive: true });
  await mkdir(refreshDir, { recursive: true });

  // Enough of the build environment for the rovodev branch to run: a fake
  // download, a fake `install`, a fake arch probe, and an `acli` that exists.
  await stub('dpkg', 'echo arm64');
  await stub('curl', 'exit 0');
  await stub('install', 'exit 0');
  await stub('mktemp', `echo ${path.join(dir, 'dl.tmp')}`);
  await stub('acli', 'exit 0');
  // The site-preset helper is written into a fixed path; redirect it too.
  presetScript = path.join(dir, 'rovodev-billing-site.py');

  const src = await readFile(INSTALL_SH, 'utf8');
  // Redirect the hook directory into the sandbox; everything else runs as-is.
  const patched = src
    .replaceAll('/usr/local/share/monoceros/post-create.d', postCreate)
    .replaceAll('/usr/local/share/monoceros/refresh.d', refreshDir)
    .replaceAll(
      '/usr/local/share/monoceros/rovodev-billing-site.py',
      presetScript,
    );
  const installer = path.join(dir, 'install.sh');
  await writeFile(installer, patched);

  const result = await run(installer, {
    ROVODEV: 'true',
    TWG: 'false',
    FORGE: 'false',
    EMAIL: 'someone@example.test',
    APITOKEN: 'classic-token-value',
    ROVODEVTOKEN: 'scoped-token-value',
  });
  expect(result.code).toBe(0);
  hook = path.join(postCreate, 'atlassian-rovodev.sh');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the billing-site preset', () => {
  const configPath = (): string => path.join(dir, '.rovodev', 'config.yml');

  const runPreset = (site: string): Promise<{ code: number; stdout: string }> =>
    new Promise((resolve) => {
      execFile(
        'python3',
        [presetScript, site],
        { env: { HOME: dir, PATH: process.env.PATH ?? '' } },
        (err, stdout) => {
          const code =
            err && typeof (err as { code?: number }).code === 'number'
              ? (err as { code: number }).code
              : 0;
          resolve({ code, stdout: String(stdout) });
        },
      );
    });

  it('fills an unset siteUrl and leaves the rest of the file alone', async () => {
    const before = [
      '# acli writes a commented template; it must survive.',
      'sessionFeedback:',
      '  permanentlyDisabled: false',
      '',
      'atlassianBillingSite:',
      '  # Which site Rovo Dev bills against',
      '  siteUrl: null',
      '',
      'smartTasks:',
      '  enabled: true',
      '',
    ].join('\n');
    await mkdir(path.dirname(configPath()), { recursive: true });
    await writeFile(configPath(), before);
    const result = await runPreset('conciso.atlassian.net');
    expect(result.code).toBe(0);
    const after = await readFile(configPath(), 'utf8');
    expect(after).toContain('  siteUrl: https://conciso.atlassian.net');
    // Comments and every other key are untouched.
    expect(after).toContain('# acli writes a commented template');
    expect(after).toContain('  # Which site Rovo Dev bills against');
    expect(after).toContain('smartTasks:');
  });

  it('never overwrites a site the builder already answered', async () => {
    await mkdir(path.dirname(configPath()), { recursive: true });
    await writeFile(
      configPath(),
      'atlassianBillingSite:\n  siteUrl: https://other.atlassian.net\n',
    );
    await runPreset('conciso.atlassian.net');
    expect(await readFile(configPath(), 'utf8')).toContain(
      'siteUrl: https://other.atlassian.net',
    );
  });

  it('creates a minimal config when there is none yet', async () => {
    await rm(path.join(dir, '.rovodev'), { recursive: true, force: true });
    await runPreset('conciso.atlassian.net');
    expect(await readFile(configPath(), 'utf8')).toBe(
      'atlassianBillingSite:\n  siteUrl: https://conciso.atlassian.net\n',
    );
  });

  it('appends the block when the file has no billing key at all', async () => {
    await mkdir(path.dirname(configPath()), { recursive: true });
    await writeFile(configPath(), 'smartTasks:\n  enabled: true\n');
    await runPreset('conciso.atlassian.net');
    const after = await readFile(configPath(), 'utf8');
    expect(after).toContain('smartTasks:');
    expect(after).toContain(
      'atlassianBillingSite:\n  siteUrl: https://conciso.atlassian.net',
    );
  });

  it('takes a bare host and an explicit URL alike, and ignores an empty site', async () => {
    await rm(path.join(dir, '.rovodev'), { recursive: true, force: true });
    await runPreset('https://already.atlassian.net');
    expect(await readFile(configPath(), 'utf8')).toContain(
      'siteUrl: https://already.atlassian.net',
    );
    await rm(path.join(dir, '.rovodev'), { recursive: true, force: true });
    const result = await runPreset('');
    expect(result.code).toBe(0);
    await expect(readFile(configPath(), 'utf8')).rejects.toThrow();
  });
});

describe('the generated Rovo Dev login hook', () => {
  it('bakes in no token, so a rotation is not outlived by the layer cache', async () => {
    const body = await readFile(hook, 'utf8');
    expect(body).not.toContain('scoped-token-value');
    expect(body).not.toContain('classic-token-value');
    expect(body).toContain('ATLASSIAN_ROVODEV_TOKEN');
  });

  it('logs in with the token from the environment, via stdin', async () => {
    const seen = path.join(dir, 'stdin.txt');
    await stub('acli', `cat > ${seen}\necho "args: $*"`);
    const result = await run(hook, {
      ATLASSIAN_ROVODEV_EMAIL: 'someone@example.test',
      ATLASSIAN_ROVODEV_TOKEN: 'from-the-env',
    });
    expect(result.code).toBe(0);
    expect(await readFile(seen, 'utf8')).toBe('from-the-env');
    expect(result.stdout).toMatch(/auth login done/);
  });

  it('survives a failed login instead of stranding the apply', async () => {
    await stub('acli', 'echo "✗ Error: authentication failed" >&2\nexit 1');
    const result = await run(hook, {
      ATLASSIAN_ROVODEV_EMAIL: 'someone@example.test',
      ATLASSIAN_ROVODEV_TOKEN: 'a-classic-token',
    });
    // Exit 0 is the whole point: postCreate skips every later hook otherwise.
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/login FAILED/);
    // And it says what acli will not: which kind of token is needed.
    expect(result.stderr).toMatch(/scoped/);
    expect(result.stderr).toMatch(/ATLASSIAN_ROVODEV_TOKEN/);
  });

  it('says what to do when no token is set at all', async () => {
    await stub('acli', 'echo "should not be called" >&2\nexit 1');
    const result = await run(hook, {});
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/no ATLASSIAN_ROVODEV_TOKEN set/);
    expect(result.stdout).toMatch(/API token with scopes/);
    expect(result.stderr).not.toMatch(/should not be called/);
  });
});
