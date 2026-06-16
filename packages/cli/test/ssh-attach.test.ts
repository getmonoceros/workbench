import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  removeSshAttach,
  setupSshAttach,
  sshConfigEntryPath,
  sshProxyScriptPath,
  type KeygenSpawn,
} from '../src/devcontainer/ssh-attach.js';

let root: string;
let home: string;
let targetDir: string;
let userSshDir: string;

// A stub ssh-keygen that records its calls and, on success, creates the
// private/public key files at the `-f` path (so the reuse path sees them).
function fakeKeygen(opts: { fail?: boolean } = {}): {
  spawn: KeygenSpawn;
  calls: () => number;
} {
  let count = 0;
  const spawn: KeygenSpawn = async (args) => {
    count += 1;
    if (opts.fail) return { exitCode: 1, stderr: 'boom' };
    const fIdx = args.indexOf('-f');
    const keyPath = args[fIdx + 1] as string;
    await writeFile(keyPath, 'PRIVATE');
    await writeFile(`${keyPath}.pub`, 'ssh-ed25519 AAAA monoceros\n');
    return { exitCode: 0, stderr: '' };
  };
  return { spawn, calls: () => count };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mono-ssh-'));
  home = path.join(root, 'home');
  targetDir = path.join(home, 'container', 'demo');
  userSshDir = path.join(root, 'user-ssh');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('setupSshAttach', () => {
  it('mints a keypair and registers a host entry + include', async () => {
    const kg = fakeKeygen();
    const res = await setupSshAttach({
      name: 'demo',
      targetDir,
      home,
      userSshDir,
      keygen: kg.spawn,
    });

    expect(res.configured).toBe(true);
    expect(res.hostAlias).toBe('monoceros-demo');
    expect(kg.calls()).toBe(1);

    // keypair under the container dir
    expect(existsSync(path.join(targetDir, '.monoceros/ssh/id_ed25519'))).toBe(
      true,
    );
    expect(
      existsSync(path.join(targetDir, '.monoceros/ssh/id_ed25519.pub')),
    ).toBe(true);

    // proxy script is executable and resolves the container by label
    const proxyPath = sshProxyScriptPath(home, 'demo');
    const proxy = await readFile(proxyPath, 'utf8');
    expect(proxy).toContain(`devcontainer.local_folder=${targetDir}`);
    expect(proxy).toContain('socat - TCP:127.0.0.1:22');
    const mode = (await stat(proxyPath)).mode & 0o111;
    expect(mode).not.toBe(0);

    // config.d entry points at the alias, key, and proxy script
    const entry = await readFile(sshConfigEntryPath(home, 'demo'), 'utf8');
    expect(entry).toContain('Host monoceros-demo');
    expect(entry).toContain(
      `IdentityFile "${path.join(targetDir, '.monoceros/ssh/id_ed25519')}"`,
    );
    expect(entry).toContain(`ProxyCommand "${proxyPath}"`);

    // include line added to the user's ssh config
    const userConfig = await readFile(path.join(userSshDir, 'config'), 'utf8');
    expect(userConfig).toContain(
      `Include "${path.join(home, 'ssh', 'config.d', '*')}"`,
    );
  });

  it('is idempotent: re-running does not duplicate the include or re-mint', async () => {
    const kg = fakeKeygen();
    await setupSshAttach({
      name: 'demo',
      targetDir,
      home,
      userSshDir,
      keygen: kg.spawn,
    });
    await setupSshAttach({
      name: 'demo',
      targetDir,
      home,
      userSshDir,
      keygen: kg.spawn,
    });

    // existing keypair reused - keygen only ran the first time
    expect(kg.calls()).toBe(1);

    const userConfig = await readFile(path.join(userSshDir, 'config'), 'utf8');
    const includeCount = userConfig.split('Include "').length - 1;
    expect(includeCount).toBe(1);
  });

  it('preserves an existing user ssh config (prepends, never overwrites)', async () => {
    const kg = fakeKeygen();
    const { mkdir } = await import('node:fs/promises');
    await mkdir(userSshDir, { recursive: true });
    const configPath = path.join(userSshDir, 'config');
    await writeFile(configPath, 'Host myserver\n    HostName 10.0.0.1\n');

    await setupSshAttach({
      name: 'demo',
      targetDir,
      home,
      userSshDir,
      keygen: kg.spawn,
    });

    const userConfig = await readFile(configPath, 'utf8');
    expect(userConfig).toContain('Host myserver');
    expect(userConfig).toContain('Include "');
  });

  it('degrades gracefully when ssh-keygen fails', async () => {
    const kg = fakeKeygen({ fail: true });
    const res = await setupSshAttach({
      name: 'demo',
      targetDir,
      home,
      userSshDir,
      keygen: kg.spawn,
    });

    expect(res.configured).toBe(false);
    expect(existsSync(sshProxyScriptPath(home, 'demo'))).toBe(false);
    expect(existsSync(sshConfigEntryPath(home, 'demo'))).toBe(false);
    expect(existsSync(path.join(userSshDir, 'config'))).toBe(false);
  });
});

describe('removeSshAttach', () => {
  it('removes the proxy script and config.d entry, leaves the include', async () => {
    const kg = fakeKeygen();
    await setupSshAttach({
      name: 'demo',
      targetDir,
      home,
      userSshDir,
      keygen: kg.spawn,
    });

    await removeSshAttach(home, 'demo');

    expect(existsSync(sshProxyScriptPath(home, 'demo'))).toBe(false);
    expect(existsSync(sshConfigEntryPath(home, 'demo'))).toBe(false);
    // include line is intentionally left in place
    const userConfig = await readFile(path.join(userSshDir, 'config'), 'utf8');
    expect(userConfig).toContain('Include "');
  });

  it('is a no-op when nothing was set up', async () => {
    await expect(removeSshAttach(home, 'never')).resolves.toBeUndefined();
  });
});
