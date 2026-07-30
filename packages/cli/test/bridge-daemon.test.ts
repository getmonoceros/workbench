import { existsSync, promises as fsp, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimeSupportsBrowserBridge } from '../src/create/catalog.js';
import {
  bridgePidFile,
  runBridgeDaemon,
  runningBridgePid,
} from '../src/devcontainer/bridge-daemon.js';
import {
  relayDir,
  startBrowserBridge,
} from '../src/devcontainer/browser-bridge.js';

describe('runtimeSupportsBrowserBridge', () => {
  it('gates the always-on bridge on runtime 1.3.3', () => {
    expect(runtimeSupportsBrowserBridge(undefined)).toBe(false);
    expect(runtimeSupportsBrowserBridge('1.3.2')).toBe(false);
    expect(runtimeSupportsBrowserBridge('1.3.3')).toBe(true);
    expect(runtimeSupportsBrowserBridge('1.4.0')).toBe(true);
  });
});

describe('bridge-daemon pid tracking', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mono-bridge-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('locates the pid file under the relay dir', () => {
    expect(bridgePidFile(root)).toBe(
      path.join(root, '.monoceros-bridge', 'daemon.pid'),
    );
  });

  it('reports the pid only when the recorded process is alive', async () => {
    expect(runningBridgePid(root)).toBeNull(); // no file yet

    await fsp.mkdir(path.dirname(bridgePidFile(root)), { recursive: true });
    writeFileSync(bridgePidFile(root), String(process.pid));
    expect(runningBridgePid(root)).toBe(process.pid); // this test process is alive

    // A pid that cannot be running → treated as no live daemon.
    writeFileSync(bridgePidFile(root), '2147483647');
    expect(runningBridgePid(root)).toBeNull();
  });
});

describe('runBridgeDaemon lifecycle', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mono-bridge-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('exits when the container is no longer running and cleans up its pid file', async () => {
    // dockerExec reports "no running container" → the lifecheck ends the loop.
    const dockerExec = async () => ({ exitCode: 0, stdout: '', stderr: '' });
    const spawn = async () => 0;

    await runBridgeDaemon({
      root,
      dockerExec,
      spawn,
      lifecheckMs: 10,
    });

    // The pid file is created on start and removed on exit.
    expect(existsSync(bridgePidFile(root))).toBe(false);
  });

  it('clears a leftover URL file on start so a stale URL is not auto-opened', async () => {
    const urlFile = path.join(root, '.monoceros-bridge', 'url');
    await fsp.mkdir(path.dirname(urlFile), { recursive: true });
    await fsp.writeFile(
      urlFile,
      'https://stale.example/from-a-prior-session\n',
    );

    await runBridgeDaemon({
      root,
      dockerExec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
      spawn: async () => 0,
      lifecheckMs: 10,
    });

    expect(existsSync(urlFile)).toBe(false);
  });
});

describe('per-session bridge cleanup', () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mono-bridge-'));
  });
  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const noSpawn = async (): Promise<number> => 0;

  it('leaves a running daemon its pid file when the session ends', async () => {
    // The daemon outlives the session and keeps its pid file in the same relay
    // dir. Wiping the dir on dispose would strand it: `apply`/`start` would
    // spawn a second daemon and `remove` could no longer stop the first.
    await fsp.mkdir(relayDir(root), { recursive: true });
    await fsp.writeFile(bridgePidFile(root), String(process.pid));

    const bridge = await startBrowserBridge({
      name: 'acme',
      root,
      spawn: noSpawn,
    });
    await bridge.dispose();

    expect(runningBridgePid(root)).toBe(process.pid);
    // Everything the session itself put there is gone.
    expect(await fsp.readdir(relayDir(root))).toEqual(['daemon.pid']);
  });

  it('takes the relay dir with it when no daemon is running', async () => {
    const bridge = await startBrowserBridge({
      name: 'acme',
      root,
      spawn: noSpawn,
    });
    expect(existsSync(path.join(relayDir(root), 'xdg-open'))).toBe(true);

    await bridge.dispose();
    expect(existsSync(relayDir(root))).toBe(false);
  });
});
