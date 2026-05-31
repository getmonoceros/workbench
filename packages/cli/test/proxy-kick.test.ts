import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROXY_CONTAINER_NAME,
  kickProxyReload,
  type DockerExec,
  type DockerResult,
} from '../src/proxy/index.js';

/**
 * `kickProxyReload` is a Windows-only workaround: Docker Desktop's
 * bind-mount layer doesn't deliver inotify events reliably, so
 * Traefik's file-provider auto-reload silently misses host-side
 * writes to its dynamic-config dir. The fix is a forced `docker
 * restart` of the proxy container — but only when (a) we're on
 * Windows AND (b) the proxy is currently running. Both conditions
 * matter; getting either wrong wastes a restart or breaks Linux.
 */

const ok = (stdout = ''): DockerResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr = '', exitCode = 1): DockerResult => ({
  stdout: '',
  stderr,
  exitCode,
});

interface FakeDocker {
  exec: DockerExec;
  calls: string[][];
}

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

describe('kickProxyReload', () => {
  const originalPlatform = process.platform;

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p });
  }

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe('off Windows', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    it('never touches docker (no inspect, no restart)', async () => {
      const d = fakeDocker(() => ok());
      await kickProxyReload({ docker: d.exec });
      expect(d.calls).toEqual([]);
    });

    it('also no-ops on darwin', async () => {
      setPlatform('darwin');
      const d = fakeDocker(() => ok());
      await kickProxyReload({ docker: d.exec });
      expect(d.calls).toEqual([]);
    });
  });

  describe('on Windows', () => {
    beforeEach(() => {
      setPlatform('win32');
    });

    it('restarts the proxy when it is running', async () => {
      const d = fakeDocker((args) => {
        if (args[0] === 'inspect') return ok('true\n');
        if (args[0] === 'restart') return ok();
        return fail('unexpected docker call');
      });
      await kickProxyReload({ docker: d.exec });
      expect(d.calls).toEqual([
        ['inspect', '--format', '{{.State.Running}}', PROXY_CONTAINER_NAME],
        ['restart', PROXY_CONTAINER_NAME],
      ]);
    });

    it('skips restart when the proxy exists but is stopped', async () => {
      const d = fakeDocker(() => ok('false\n'));
      await kickProxyReload({ docker: d.exec });
      expect(d.calls).toHaveLength(1);
      expect(d.calls[0]?.[0]).toBe('inspect');
    });

    it('skips restart when the proxy container does not exist', async () => {
      // `docker inspect` on a missing container exits non-zero with a
      // "No such object" stderr. kickProxyReload should treat that as
      // "nothing to kick" and return cleanly — first apply on a fresh
      // machine takes this path before ensureProxy runs.
      const d = fakeDocker(() => fail('No such object: monoceros-proxy'));
      await kickProxyReload({ docker: d.exec });
      expect(d.calls).toHaveLength(1);
      expect(d.calls[0]?.[0]).toBe('inspect');
    });
  });
});
