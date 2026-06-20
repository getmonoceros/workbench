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
});
