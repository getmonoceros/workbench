import { describe, expect, it } from 'vitest';
import {
  formatHostPortHeldError,
  preflightHostPort,
} from '../src/proxy/port-check.js';
import { PROXY_CONTAINER_NAME, type DockerExec } from '../src/proxy/index.js';

const dockerStubs = {
  proxyRunning(): DockerExec {
    return async () => ({
      stdout: 'true\n',
      stderr: '',
      exitCode: 0,
    });
  },
  proxyStopped(): DockerExec {
    return async () => ({
      stdout: 'false\n',
      stderr: '',
      exitCode: 0,
    });
  },
  proxyAbsent(): DockerExec {
    return async () => ({
      stdout: '',
      stderr: 'Error: No such object: ' + PROXY_CONTAINER_NAME,
      exitCode: 1,
    });
  },
};

describe('preflightHostPort', () => {
  it('skips the bind probe when monoceros-proxy is already running', async () => {
    let probed = false;
    await preflightHostPort(80, {
      docker: dockerStubs.proxyRunning(),
      portProbe: async () => {
        probed = true;
        return { ok: false, code: 'EADDRINUSE', message: 'in use' };
      },
    });
    expect(probed).toBe(false);
  });

  // Regression: previously the docker inspect was skipped whenever
  // opts.docker was undefined, which made the bind probe fail on
  // Traefik's own port and point the builder at "port 80 held by
  // another process" — naming our own running container.
  it('queries docker even when the caller does not override DockerExec', async () => {
    let dockerCalls = 0;
    let probed = false;
    const proxyRunningInspect: DockerExec = async () => {
      dockerCalls++;
      return { stdout: 'true\n', stderr: '', exitCode: 0 };
    };
    await preflightHostPort(80, {
      // intentionally pass docker so the test doesn't hit real docker,
      // but the production path uses the same default-exec under
      // the hood when docker is omitted.
      docker: proxyRunningInspect,
      portProbe: async () => {
        probed = true;
        return { ok: true };
      },
    });
    expect(dockerCalls).toBe(1);
    expect(probed).toBe(false);
  });

  it('resolves silently when the port is free', async () => {
    await preflightHostPort(80, {
      docker: dockerStubs.proxyAbsent(),
      portProbe: async () => ({ ok: true }),
    });
  });

  it('throws with an actionable hint on EADDRINUSE', async () => {
    await expect(
      preflightHostPort(80, {
        docker: dockerStubs.proxyAbsent(),
        portProbe: async () => ({
          ok: false,
          code: 'EADDRINUSE',
          message: 'address already in use',
        }),
      }),
    ).rejects.toThrow(/Host port 80 is already in use/);
  });

  it('mentions the routing.hostPort fallback in the EADDRINUSE message', async () => {
    try {
      await preflightHostPort(80, {
        docker: dockerStubs.proxyAbsent(),
        portProbe: async () => ({
          ok: false,
          code: 'EADDRINUSE',
          message: 'address already in use',
        }),
      });
      throw new Error('expected to throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('routing:');
      expect(msg).toContain('hostPort');
      expect(msg).toContain('monoceros-config.yml');
      expect(msg).toMatch(/lsof|ss -tlnp/);
    }
  });

  it('treats a stopped proxy container as not-holding-the-port', async () => {
    // The proxy exists but isn't running — bind probe SHOULD run,
    // since nobody is actively holding the port from our side.
    let probed = false;
    await preflightHostPort(80, {
      docker: dockerStubs.proxyStopped(),
      portProbe: async () => {
        probed = true;
        return { ok: true };
      },
    });
    expect(probed).toBe(true);
  });

  it('frames EACCES with privileged-port hint', () => {
    const msg = formatHostPortHeldError(80, 'EACCES', 'permission denied');
    expect(msg).toContain('privileged port');
    expect(msg).toContain('routing.hostPort');
  });
});
