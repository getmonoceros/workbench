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
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * How the feature calls twg's official install script.
 *
 * The consent step is the whole point of this test. It used to read a `yes`
 * off stdin; upstream changed it to refuse prompting at all without a
 * controlling terminal, and a `monoceros apply` has neither. The feature build
 * died on it. The install script only forwards the up-front consent for an
 * install that is unattended in every respect, so `--yes` alone is not enough:
 * it counts only alongside `--skip-login` and `--skip-skills`.
 *
 * So: run the feature's own install.sh with a stubbed download, and check the
 * arguments the install script is handed.
 */

const INSTALL_SH = fileURLToPath(
  new URL('../../../components/features/atlassian/install.sh', import.meta.url),
);

let dir: string;
let argsFile: string;

async function stub(binDir: string, name: string, body: string): Promise<void> {
  const file = path.join(binDir, name);
  await writeFile(file, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(file, 0o755);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'monoceros-twg-'));
  const binDir = path.join(dir, 'bin');
  const postCreate = path.join(dir, 'post-create.d');
  const refreshDir = path.join(dir, 'refresh.d');
  await mkdir(binDir, { recursive: true });
  await mkdir(postCreate, { recursive: true });
  await mkdir(refreshDir, { recursive: true });

  argsFile = path.join(dir, 'install-args');
  const downloaded = path.join(dir, 'twg-install.sh');

  await stub(binDir, 'dpkg', 'echo arm64');
  await stub(binDir, 'mktemp', `echo ${downloaded}`);
  // Stand in for the download: drop a script that records how it was called.
  await stub(
    binDir,
    'curl',
    `printf '#!/usr/bin/env bash\\nprintf "%%s\\\\n" "$@" > ${argsFile}\\n' > ${downloaded}`,
  );
  await stub(binDir, 'twg', 'exit 0');

  const src = await readFile(INSTALL_SH, 'utf8');
  const installer = path.join(dir, 'install.sh');
  await writeFile(
    installer,
    src
      .replaceAll('/usr/local/share/monoceros/post-create.d', postCreate)
      .replaceAll('/usr/local/share/monoceros/refresh.d', refreshDir),
  );

  const result = await new Promise<{ code: number; stderr: string }>(
    (resolve) => {
      execFile(
        'bash',
        [installer],
        {
          env: {
            PATH: `${binDir}:${process.env.PATH ?? ''}`,
            HOME: dir,
            ROVODEV: 'false',
            TWG: 'true',
            FORGE: 'false',
            INSTANCE: 'example.atlassian.net',
            EMAIL: 'someone@example.test',
            APITOKEN: 'token-value',
          },
        },
        (err, _stdout, stderr) => {
          const code =
            err && typeof (err as { code?: number }).code === 'number'
              ? (err as { code: number }).code
              : 0;
          resolve({ code, stderr: String(stderr) });
        },
      );
    },
  );
  expect(result.code).toBe(0);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('agrees to the consent up front, the only way an unattended install gets it', async () => {
  const args = (await readFile(argsFile, 'utf8')).split('\n').filter(Boolean);
  expect(args).toContain('--yes');
  // Upstream forwards --yes only when the install skips login and skills too;
  // drop either one and the consent step goes back to prompting.
  expect(args).toContain('--skip-login');
  expect(args).toContain('--skip-skills');
  expect(args).toContain('--install-dir');
});
