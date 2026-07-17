import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROXY_CONTAINER_NAME,
  PROXY_NETWORK_NAME,
  ensureProxy,
  maybeStopProxy,
  proxyDynamicDir,
  type DockerExec,
  type DockerResult,
} from '../src/proxy/index.js';

const ok = (stdout = ''): DockerResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): DockerResult => ({
  stdout: '',
  stderr,
  exitCode,
});

interface FakeDocker {
  exec: DockerExec;
  calls: string[][];
}

/** Build a fake DockerExec from a callback that returns the result. */
function fakeDocker(
  handler: (args: string[], call: number) => DockerResult,
): FakeDocker {
  const calls: string[][] = [];
  const exec: DockerExec = async (args) => {
    const call = calls.length;
    calls.push(args);
    return handler(args, call);
  };
  return { exec, calls };
}

const silentLogger = { info: () => {}, warn: () => {} };

describe('ensureProxy', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'monoceros-proxy-'));
  });

  afterEach(() => {
    if (home && existsSync(home))
      rmSync(home, { recursive: true, force: true });
  });

  it('creates the dynamic dir on first invocation', async () => {
    const docker = fakeDocker((args) => {
      // pretend everything exists and is running
      if (args[0] === 'network' && args[1] === 'inspect') return ok();
      if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) {
        return ok('true\n');
      }
      return ok();
    });
    await ensureProxy({
      docker: docker.exec,
      monocerosHome: home,
      logger: silentLogger,
    });
    expect(existsSync(proxyDynamicDir(home))).toBe(true);
  });

  it('creates the network when missing and starts the container when absent', async () => {
    const docker = fakeDocker((args, call) => {
      // 1: network inspect → missing
      if (call === 0) return fail('Error: No such network');
      // 2: network create → ok
      if (call === 1) return ok();
      // 3: container inspect → missing
      if (call === 2) return fail('Error: No such object');
      // 4: docker run → ok
      if (call === 3) return ok('deadbeef\n');
      return ok();
    });
    await ensureProxy({
      docker: docker.exec,
      monocerosHome: home,
      logger: silentLogger,
    });
    expect(docker.calls.map((c) => c.slice(0, 2))).toEqual([
      ['network', 'inspect'],
      ['network', 'create'],
      ['inspect', '--format'],
      ['run', '-d'],
    ]);
    // run command must include all canonical flags
    const runCall = docker.calls[3]!;
    expect(runCall).toContain('--name');
    expect(runCall).toContain(PROXY_CONTAINER_NAME);
    expect(runCall).toContain('--network');
    expect(runCall).toContain(PROXY_NETWORK_NAME);
    expect(runCall.join(' ')).toContain('80:80');
    expect(runCall.join(' ')).toContain('--providers.file.directory=');
    expect(runCall.join(' ')).toContain('--providers.file.watch=true');
    expect(runCall.join(' ')).toContain('--providers.docker=false');
    // Fresh proxy carries a restart policy so it survives a Docker restart.
    expect(runCall).toContain('--restart');
    expect(runCall).toContain('unless-stopped');
  });

  it('heals the restart policy and starts the container when it exists but is stopped', async () => {
    const docker = fakeDocker((args, call) => {
      if (call === 0) return ok(); // network exists
      if (call === 1) return ok('false\n'); // container exists but stopped
      if (call === 2) return ok(); // docker update → ok
      if (call === 3) return ok(); // docker start → ok
      return ok();
    });
    await ensureProxy({
      docker: docker.exec,
      monocerosHome: home,
      logger: silentLogger,
    });
    expect(docker.calls.map((c) => c[0])).toEqual([
      'network',
      'inspect',
      'update',
      'start',
    ]);
    expect(docker.calls[2]).toEqual([
      'update',
      '--restart',
      'unless-stopped',
      PROXY_CONTAINER_NAME,
    ]);
    expect(docker.calls[3]).toEqual(['start', PROXY_CONTAINER_NAME]);
  });

  it('heals the restart policy and does not re-start when already running', async () => {
    const docker = fakeDocker((args, call) => {
      if (call === 0) return ok(); // network exists
      if (call === 1) return ok('true\n'); // container running
      return ok();
    });
    await ensureProxy({
      docker: docker.exec,
      monocerosHome: home,
      logger: silentLogger,
    });
    // network inspect + container inspect + `docker update` (heal), then
    // return — no `start`/`run` because it is already up.
    expect(docker.calls.map((c) => c[0])).toEqual([
      'network',
      'inspect',
      'update',
    ]);
  });

  it('surfaces docker errors with the stderr verbatim', async () => {
    const docker = fakeDocker((args, call) => {
      if (call === 0) return fail('Error: No such network');
      if (call === 1) return fail('permission denied while trying to connect');
      return ok();
    });
    await expect(
      ensureProxy({
        docker: docker.exec,
        monocerosHome: home,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('maybeStopProxy', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'monoceros-proxy-'));
  });

  afterEach(() => {
    if (home && existsSync(home))
      rmSync(home, { recursive: true, force: true });
  });

  it('no-ops when the network does not exist', async () => {
    const docker = fakeDocker(() => fail('Error: No such network'));
    await maybeStopProxy({
      docker: docker.exec,
      monocerosHome: home,
      logger: silentLogger,
    });
    expect(docker.calls).toHaveLength(1);
    expect(docker.calls[0]!.slice(0, 2)).toEqual(['network', 'inspect']);
  });

  it('no-ops when other containers still reference the network', async () => {
    const docker = fakeDocker((args, call) => {
      if (call === 0) return ok(); // inspect: network exists
      return ok(`${PROXY_CONTAINER_NAME}\nsandbox\nother\n`); // ps -a
    });
    await maybeStopProxy({
      docker: docker.exec,
      monocerosHome: home,
      logger: silentLogger,
    });
    // inspect + ps -a; no rm, no network rm
    expect(docker.calls).toHaveLength(2);
    expect(docker.calls[1]!.slice(0, 4)).toEqual([
      'ps',
      '-a',
      '--filter',
      `network=${PROXY_NETWORK_NAME}`,
    ]);
  });

  it('no-ops when a merely-stopped port-container still references the network', async () => {
    // Regression: a stopped container is absent from `network inspect`'s
    // running-only `.Containers` map but present in `ps -a` by config. It
    // must keep the proxy alive so `start` re-attaches to the same network.
    const docker = fakeDocker((args, call) => {
      if (call === 0) return ok(); // inspect: network exists
      return ok(`${PROXY_CONTAINER_NAME}\nmonoceros-acme\n`); // ps -a: acme (stopped)
    });
    await maybeStopProxy({
      docker: docker.exec,
      monocerosHome: home,
      logger: silentLogger,
    });
    expect(docker.calls).toHaveLength(2);
    expect(docker.calls.some((c) => c[0] === 'rm')).toBe(false);
    expect(docker.calls.some((c) => c[0] === 'network' && c[1] === 'rm')).toBe(
      false,
    );
  });

  it('drops the singleton and the network when only the proxy is left', async () => {
    const docker = fakeDocker((args, call) => {
      if (call === 0) return ok(); // inspect: network exists
      if (call === 1) return ok(`${PROXY_CONTAINER_NAME}\n`); // ps -a: only self
      return ok();
    });
    await maybeStopProxy({
      docker: docker.exec,
      monocerosHome: home,
      logger: silentLogger,
    });
    expect(docker.calls.map((c) => c.slice(0, 3))).toEqual([
      ['network', 'inspect', PROXY_NETWORK_NAME],
      ['ps', '-a', '--filter'],
      ['rm', '-f', PROXY_CONTAINER_NAME],
      ['network', 'rm', PROXY_NETWORK_NAME],
    ]);
  });

  it('drops the singleton and the network when nothing references it', async () => {
    const docker = fakeDocker((args, call) => {
      if (call === 0) return ok(); // inspect: network exists
      if (call === 1) return ok('\n'); // ps -a: no containers attached
      return ok();
    });
    await maybeStopProxy({
      docker: docker.exec,
      monocerosHome: home,
      logger: silentLogger,
    });
    expect(docker.calls).toHaveLength(4);
  });

  it('logs a warn (no throw) when network rm fails', async () => {
    const logs: string[] = [];
    const docker = fakeDocker((args, call) => {
      if (call === 0) return ok(); // inspect
      if (call === 1) return ok(`${PROXY_CONTAINER_NAME}\n`); // ps -a: only self
      if (call === 2) return ok(); // rm -f proxy
      if (call === 3) return fail('error: network has active endpoints');
      return ok();
    });
    await maybeStopProxy({
      docker: docker.exec,
      monocerosHome: home,
      logger: { info: () => {}, warn: (m) => logs.push(m) },
    });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]).toContain('active endpoints');
  });
});
