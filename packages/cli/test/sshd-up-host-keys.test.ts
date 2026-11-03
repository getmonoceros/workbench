import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SSHD_UP = path.join(
  fileURLToPath(new URL('../../..', import.meta.url)),
  'images/runtime/sshd-up.sh',
);

/** The body of one top-level shell function, `name() {` up to its `}`. */
function shellFunction(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`no function ${name} in sshd-up.sh`);
  const end = source.indexOf('\n}\n', start);
  return source.slice(start + 1, end + 2);
}

let root: string;
let store: string;

/** Run sync_host_keys against a temp root, as the entrypoint would. */
function sync(): void {
  const fn = shellFunction(readFileSync(SSHD_UP, 'utf8'), 'sync_host_keys');
  const script = ['set -euo pipefail', fn, 'sync_host_keys "$1" "$2"'].join(
    '\n',
  );
  const r = spawnSync('bash', ['-c', script, 'bash', store, root], {
    encoding: 'utf8',
  });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
}

const pub = (dir: string) =>
  readFile(path.join(dir, 'ssh_host_ed25519_key.pub'), 'utf8');

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mono-hostkeys-'));
  store = path.join(root, 'ws', '.monoceros', 'ssh', 'host');
  await mkdir(path.join(root, 'etc', 'ssh'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sshd-up.sh sync_host_keys', () => {
  it('mints per-container keys into an empty store and marks it', async () => {
    sync();
    expect(await pub(store)).toBe(await pub(path.join(root, 'etc', 'ssh')));
    expect(existsSync(path.join(store, '.per-container'))).toBe(true);
  });

  it('keeps a marked store across rebuilds', async () => {
    sync();
    const first = await pub(store);
    // A rebuild: fresh container fs, same bind-mounted store.
    await rm(path.join(root, 'etc', 'ssh'), { recursive: true });
    await mkdir(path.join(root, 'etc', 'ssh'));
    sync();
    expect(await pub(store)).toBe(first);
    expect(await pub(path.join(root, 'etc', 'ssh'))).toBe(first);
  });

  it('replaces an unmarked store, the image key older runtimes saved', async () => {
    // What runtimes up to 1.11.2 left behind: the key baked into the image,
    // shared by every container, private half public.
    await mkdir(store, { recursive: true });
    const shared = 'ssh-ed25519 AAAASHAREDIMAGEKEY root@buildkitsandbox\n';
    await writeFile(path.join(store, 'ssh_host_ed25519_key'), 'SHARED');
    await writeFile(path.join(store, 'ssh_host_ed25519_key.pub'), shared);
    sync();
    const minted = await pub(store);
    expect(minted).not.toBe(shared);
    expect(minted).toMatch(/^ssh-ed25519 /);
    expect(await pub(path.join(root, 'etc', 'ssh'))).toBe(minted);
    expect(existsSync(path.join(store, '.per-container'))).toBe(true);
  });
});
