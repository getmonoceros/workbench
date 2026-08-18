import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runShare, parseForwardPorts } from '../src/share/run.js';
import type { DockerSpawn, DockerSpawnHandle } from '../src/tunnel/run.js';
import type { ResolvedTarget } from '../src/tunnel/resolve.js';
import type { PortProbe } from '../src/tunnel/port-check.js';
import { CADDY_IMAGE } from '../src/share/caddy.js';

let home: string;

async function writeLaunch(app: string, body: unknown): Promise<void> {
  const dir = path.join(
    home,
    'container',
    'acme',
    'projects',
    app,
    '.monoceros',
  );
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'launch.json'), JSON.stringify(body));
}

const resolveStub = async (): Promise<ResolvedTarget> => ({
  network: 'net',
  targetHost: 'ws',
  internalPort: 0,
  display: 'acme',
});

/**
 * Resolves like the real thing: a bare port target lands on the workspace, a
 * `<service>:<port>` target on that service's own hostname.
 */
const resolveByTarget = async (o: {
  target: string;
}): Promise<ResolvedTarget> => {
  const colon = o.target.indexOf(':');
  const host = colon > 0 ? o.target.slice(0, colon) : 'ws';
  return { network: 'net', targetHost: host, internalPort: 0, display: host };
};

const probeFree: PortProbe = async () => ({ ok: true });
const hostStub = () => ({ ip: '192.168.1.10', mdnsName: 'host.local' });
const tlsStub = async () => ({
  caCertPath: '/home/ca/rootCA.pem',
  certDir: '/home/certs',
  certFile: 'leaf.pem',
  keyFile: 'leaf-key.pem',
});

/** Records spawned argv; each handle stays open until killed (then exits 130). */
function recordingSpawn() {
  const calls: string[][] = [];
  const handles: Array<{ kill: ReturnType<typeof vi.fn> }> = [];
  const spawn: DockerSpawn = (args) => {
    calls.push(args);
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((r) => (resolveExit = r));
    const kill = vi.fn(() => resolveExit(130));
    const handle: DockerSpawnHandle = { exited, kill };
    handles.push({ kill });
    return handle;
  };
  return { spawn, calls, handles };
}

/** Wait until `cond` holds (the spawns happen after a real fs read + awaits). */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'monoceros-share-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('runShare', () => {
  it('forwards every target that declares a port, on 0.0.0.0', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [
        { name: 'dev', command: 'x', port: 5173, default: true },
        { name: 'worker', command: 'y' }, // no port → skipped
        { name: 'api', command: 'z', port: 3001 },
      ],
    });
    const rec = recordingSpawn();
    let handler: (() => void) | undefined;
    const lines: string[] = [];

    const p = runShare({
      name: 'acme',
      app: 'web',
      monocerosHome: home,
      dockerSpawn: rec.spawn,
      resolve: resolveStub,
      probe: probeFree,
      hostAddresses: hostStub,
      provisionTls: tlsStub,
      ensureImage: async () => {},
      installSignalHandler: (h) => {
        handler = h;
        return () => {};
      },
      logger: { info: (m) => lines.push(m), warn: () => {} },
    });

    await waitFor(() => rec.calls.length >= 1);

    // a single Caddy terminator publishes every ported target (5173, 3001),
    // not the port-less worker
    expect(rec.calls).toHaveLength(1);
    const argv = rec.calls[0];
    if (!argv) throw new Error('no docker call recorded');
    const flat = argv.join(' ');
    expect(flat).toContain('-p 0.0.0.0:5173:5173');
    expect(flat).toContain('-p 0.0.0.0:3001:3001');
    expect(flat).toContain('--network=net');
    // mounts the provisioned cert dir + the generated Caddyfile, runs Caddy
    expect(flat).toContain('-v /home/certs:/certs:ro');
    expect(
      argv.some((a) => a.endsWith('.Caddyfile:/etc/caddy/Caddyfile:ro')),
    ).toBe(true);
    expect(argv).toContain(CADDY_IMAGE);
    // each ported target lists both addresses as equal https lines: the IP
    // and the mDNS name (neither demoted to a fallback)
    const banner = lines.join('\n');
    expect(banner).toContain('https://host.local:5173');
    expect(banner).toContain('https://host.local:3001');
    expect(banner).toContain('https://192.168.1.10:5173');
    expect(banner).toContain('https://192.168.1.10:3001');
    // the CA-trust hint points at the provisioned root cert
    expect(banner).toContain('/home/ca/rootCA.pem');

    // Ctrl+C tears every forward down and the command returns clean
    handler?.();
    for (const h of rec.handles) expect(h.kill).toHaveBeenCalledWith('SIGTERM');
    await expect(p).resolves.toBe(0);
  });

  it('on WSL leads with the Windows LAN IP and covers it in the cert', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'dev', command: 'x', port: 5173 }],
    });
    const rec = recordingSpawn();
    let handler: (() => void) | undefined;
    const lines: string[] = [];
    let capturedSans: string[] = [];

    const p = runShare({
      name: 'acme',
      app: 'web',
      monocerosHome: home,
      dockerSpawn: rec.spawn,
      resolve: resolveStub,
      probe: probeFree,
      // the enumerated IP is the dead WSL-NAT address
      hostAddresses: () => ({ ip: '172.25.23.154', mdnsName: 'host.local' }),
      resolveWindowsLanIp: async () => '192.168.178.46',
      provisionTls: async ({ sans }) => {
        capturedSans = sans;
        return tlsStub();
      },
      ensureImage: async () => {},
      installSignalHandler: (h) => {
        handler = h;
        return () => {};
      },
      logger: { info: (m) => lines.push(m), warn: () => {} },
    });

    await waitFor(() => rec.calls.length >= 1);

    const banner = lines.join('\n');
    // the reachable Windows LAN IP is offered as an equal line; the dead
    // WSL-NAT IP never shows
    expect(banner).toContain('https://192.168.178.46:5173');
    expect(banner).not.toContain('172.25.23.154');
    // `.local` is offered as an equal line alongside the IP
    expect(banner).toContain('https://host.local:5173');
    // the leaf cert covers the reachable IP, not the dead WSL-NAT one
    expect(capturedSans).toContain('192.168.178.46');
    expect(capturedSans).not.toContain('172.25.23.154');

    handler?.();
    await expect(p).resolves.toBe(0);
  });

  // A missing launch config or a portless app is only fatal when the workbench
  // has no shareable service either - the warning-and-carry-on path has its own
  // tests further down.
  it('stops when the app has no launch config and nothing else is shareable', async () => {
    await expect(
      runShare({
        name: 'acme',
        app: 'ghost',
        monocerosHome: home,
        dockerSpawn: recordingSpawn().spawn,
        resolve: resolveStub,
        probe: probeFree,
        hostAddresses: hostStub,
      }),
    ).rejects.toThrow(/Nothing to share in 'acme'/);
  });

  it('stops when no target declares a port and nothing else is shareable', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'worker', command: 'y' }],
    });
    await expect(
      runShare({
        name: 'acme',
        app: 'web',
        monocerosHome: home,
        dockerSpawn: recordingSpawn().spawn,
        resolve: resolveStub,
        probe: probeFree,
        hostAddresses: hostStub,
      }),
    ).rejects.toThrow(/declares no port, and no service declares an/);
  });

  it('remaps a busy port to a different host port with --forward-ports', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'dev', command: 'x', port: 5173 }],
    });
    const rec = recordingSpawn();
    let handler: (() => void) | undefined;
    const lines: string[] = [];

    const p = runShare({
      name: 'acme',
      app: 'web',
      monocerosHome: home,
      forwardPorts: [{ host: 15173, container: 5173 }],
      dockerSpawn: rec.spawn,
      resolve: resolveStub,
      probe: probeFree,
      hostAddresses: hostStub,
      provisionTls: tlsStub,
      ensureImage: async () => {},
      installSignalHandler: (h) => {
        handler = h;
        return () => {};
      },
      logger: { info: (m) => lines.push(m), warn: () => {} },
    });

    await waitFor(() => rec.calls.length >= 1);

    const argv = rec.calls[0];
    if (!argv) throw new Error('no docker call recorded');
    // The listener moves with the host port, so the publish is 1:1 and the
    // upstream port lives in the Caddyfile. That is what lets an app port and a
    // service's HTTP port that share a number coexist.
    expect(argv.join(' ')).toContain('-p 0.0.0.0:15173:15173');
    const caddyfile = await readFile(
      path.join(home, 'share', 'acme__web.Caddyfile'),
      'utf8',
    );
    expect(caddyfile).toContain(':15173 {');
    expect(caddyfile).toContain('reverse_proxy http://ws:5173');
    // the banner advertises the effective host port on both addresses
    const banner = lines.join('\n');
    expect(banner).toContain('https://192.168.1.10:15173');
    expect(banner).toContain('https://host.local:15173');

    handler?.();
    await expect(p).resolves.toBe(0);
  });

  it('falls back to the IDE explanation when no container published the port', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'dev', command: 'x', port: 5173 }],
    });
    // 5173 is held (the IDE's loopback forward); every other probed port is
    // free, so the suggested remap resolves to a concrete free host port.
    const probe: PortProbe = async (port) =>
      port === 5173
        ? { ok: false, code: 'EADDRINUSE', message: 'busy' }
        : { ok: true };
    await expect(
      runShare({
        name: 'acme',
        app: 'web',
        monocerosHome: home,
        dockerSpawn: recordingSpawn().spawn,
        resolve: resolveStub,
        probe,
        // docker knows of nothing on that port, which is what a Remote-SSH
        // auto-forward looks like: it binds 127.0.0.1 from the host
        docker: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        hostAddresses: hostStub,
      }),
    ).rejects.toThrow(
      /host port 5173 already in use[\s\S]*IDE[\s\S]*--forward-ports 15173:5173/,
    );
  });

  it('names the container that publishes a busy port instead of blaming the IDE', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'dev', command: 'x', port: 5173 }],
    });
    const probe: PortProbe = async (port) =>
      port === 5173
        ? { ok: false, code: 'EADDRINUSE', message: 'busy' }
        : { ok: true };
    let err: Error | undefined;
    try {
      await runShare({
        name: 'acme',
        app: 'web',
        monocerosHome: home,
        dockerSpawn: recordingSpawn().spawn,
        resolve: resolveStub,
        probe,
        // an earlier share of this workbench, still running elsewhere
        docker: async () => ({
          stdout: 'suspicious_ramanujan (caddy:2.11.4)\n',
          stderr: '',
          exitCode: 0,
        }),
        hostAddresses: hostStub,
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain('Published by a running container:');
    expect(err?.message).toContain('5173  suspicious_ramanujan (caddy:2.11.4)');
    expect(err?.message).toContain('A share of this workbench in another');
    // no IDE hunting when the holder is known
    expect(err?.message).not.toContain('PORTS panel');
    expect(err?.message).not.toContain("your IDE's");
  });

  it('rejects --forward-ports for a container port no target uses', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'dev', command: 'x', port: 5173 }],
    });
    await expect(
      runShare({
        name: 'acme',
        app: 'web',
        monocerosHome: home,
        forwardPorts: [{ host: 19999, container: 9999 }],
        dockerSpawn: recordingSpawn().spawn,
        resolve: resolveStub,
        probe: probeFree,
        hostAddresses: hostStub,
      }),
    ).rejects.toThrow(/no shared target uses it/);
  });

  it('shares a service the catalog marks shareable, under its own hostname', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'dev', command: 'x', port: 5173 }],
    });
    const rec = recordingSpawn();
    const lines: string[] = [];
    let handler: (() => void) | undefined;
    const p = runShare({
      name: 'acme',
      app: 'web',
      monocerosHome: home,
      dockerSpawn: rec.spawn,
      resolve: resolveByTarget,
      shareableServices: async () => [{ name: 'keycloak', port: 8080 }],
      probe: probeFree,
      hostAddresses: hostStub,
      provisionTls: tlsStub,
      ensureImage: async () => {},
      installSignalHandler: (h) => {
        handler = h;
        return () => {};
      },
      logger: { info: (m) => lines.push(m), warn: () => {} },
    });

    await waitFor(() => rec.calls.length >= 1);
    // the banner lists the service under its own name
    expect(lines.join('\n')).toContain('keycloak');
    const argv = rec.calls[0]!.join(' ');
    // the app port and the service port are both published
    expect(argv).toContain('-p 0.0.0.0:5173:5173');
    expect(argv).toContain('-p 0.0.0.0:8080:8080');

    const caddyfile = await readFile(
      path.join(home, 'share', 'acme__web.Caddyfile'),
      'utf8',
    );
    // the service is its own upstream: the compose service name, not `ws`
    expect(caddyfile).toContain('reverse_proxy http://keycloak:8080');
    expect(caddyfile).toContain('reverse_proxy http://ws:5173');

    handler?.();
    await expect(p).resolves.toBe(0);
  });

  it('warns about a missing launch config and shares the services anyway', async () => {
    const rec = recordingSpawn();
    const lines: string[] = [];
    const warnings: string[] = [];
    let handler: (() => void) | undefined;
    // no writeLaunch: the app has no launch config, which must not hide the
    // workbench's own services (a reverse proxy fronting them, a mail inbox)
    const p = runShare({
      name: 'acme',
      app: 'demo',
      monocerosHome: home,
      dockerSpawn: rec.spawn,
      resolve: resolveByTarget,
      shareableServices: async () => [{ name: 'caddy', port: 81 }],
      probe: probeFree,
      hostAddresses: hostStub,
      provisionTls: tlsStub,
      ensureImage: async () => {},
      installSignalHandler: (h) => {
        handler = h;
        return () => {};
      },
      logger: {
        info: (m) => lines.push(m),
        warn: (m) => warnings.push(m),
      },
    });

    await waitFor(() => rec.calls.length >= 1);
    expect(rec.calls[0]!.join(' ')).toContain('-p 0.0.0.0:81:81');
    // the warning names the missing file, the share goes on
    expect(warnings.join('\n')).toMatch(
      /No launch config for 'demo'.*services only/s,
    );
    const caddyfile = await readFile(
      path.join(home, 'share', 'acme__demo.Caddyfile'),
      'utf8',
    );
    expect(caddyfile).toContain('reverse_proxy http://caddy:81');

    handler?.();
    await expect(p).resolves.toBe(0);
  });

  it('warns about an app whose targets declare no port, and shares the services', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'worker', command: 'x' }], // no port
    });
    const rec = recordingSpawn();
    const warnings: string[] = [];
    let handler: (() => void) | undefined;
    const p = runShare({
      name: 'acme',
      app: 'web',
      monocerosHome: home,
      dockerSpawn: rec.spawn,
      resolve: resolveByTarget,
      shareableServices: async () => [{ name: 'mailpit', port: 8025 }],
      probe: probeFree,
      hostAddresses: hostStub,
      provisionTls: tlsStub,
      ensureImage: async () => {},
      installSignalHandler: (h) => {
        handler = h;
        return () => {};
      },
      logger: { info: () => {}, warn: (m) => warnings.push(m) },
    });

    await waitFor(() => rec.calls.length >= 1);
    expect(rec.calls[0]!.join(' ')).toContain('-p 0.0.0.0:8025:8025');
    expect(warnings.join('\n')).toMatch(
      /No target in 'web' declares a port.*services only/s,
    );

    handler?.();
    await expect(p).resolves.toBe(0);
  });

  it('stops when neither the app nor a service yields a port', async () => {
    await expect(
      runShare({
        name: 'acme',
        app: 'web',
        monocerosHome: home,
        dockerSpawn: recordingSpawn().spawn,
        resolve: resolveByTarget,
        shareableServices: async () => [],
        probe: probeFree,
        hostAddresses: hostStub,
        provisionTls: tlsStub,
        ensureImage: async () => {},
      }),
    ).rejects.toThrow(/no service declares an `httpPort`/);
  });

  it('sends a builder whose service wants the proxy port to the yml, not to a flag', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'dev', command: 'x', port: 5173 }],
    });
    // 80 is held (monoceros-proxy); everything else is free
    const probe: PortProbe = async (port) =>
      port === 80
        ? { ok: false, code: 'EADDRINUSE', message: 'in use' }
        : { ok: true };
    await expect(
      runShare({
        name: 'acme',
        app: 'web',
        monocerosHome: home,
        dockerSpawn: recordingSpawn().spawn,
        resolve: resolveByTarget,
        shareableServices: async () => [{ name: 'caddy', port: 80 }],
        probe,
        hostAddresses: hostStub,
        provisionTls: tlsStub,
        ensureImage: async () => {},
      }),
    ).rejects.toThrow(/set another `httpPort` in the yml/);
  });

  it('refuses when an app port and a service want the same host port, naming both', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'dev', command: 'x', port: 8080 }],
    });
    await expect(
      runShare({
        name: 'acme',
        app: 'web',
        monocerosHome: home,
        dockerSpawn: recordingSpawn().spawn,
        resolve: resolveByTarget,
        shareableServices: async () => [{ name: 'keycloak', port: 8080 }],
        probe: probeFree,
        hostAddresses: hostStub,
        provisionTls: tlsStub,
        ensureImage: async () => {},
      }),
    ).rejects.toThrow(/web:8080 and keycloak both want host port 8080/);
  });

  it('asks for the service name when a bare --forward-ports port is ambiguous', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'dev', command: 'x', port: 8080 }],
    });
    await expect(
      runShare({
        name: 'acme',
        app: 'web',
        monocerosHome: home,
        forwardPorts: [{ host: 18080, container: 8080 }],
        dockerSpawn: recordingSpawn().spawn,
        resolve: resolveByTarget,
        shareableServices: async () => [{ name: 'keycloak', port: 8080 }],
        probe: probeFree,
        hostAddresses: hostStub,
        provisionTls: tlsStub,
        ensureImage: async () => {},
      }),
    ).rejects.toThrow(/Name the one to move/);
  });

  it('moves the named service to another host port, app port untouched', async () => {
    await writeLaunch('web', {
      version: 1,
      configurations: [{ name: 'dev', command: 'x', port: 8080 }],
    });
    const rec = recordingSpawn();
    let handler: (() => void) | undefined;
    const p = runShare({
      name: 'acme',
      app: 'web',
      monocerosHome: home,
      forwardPorts: [{ host: 18080, service: 'keycloak', container: 8080 }],
      dockerSpawn: rec.spawn,
      resolve: resolveByTarget,
      shareableServices: async () => [{ name: 'keycloak', port: 8080 }],
      probe: probeFree,
      hostAddresses: hostStub,
      provisionTls: tlsStub,
      ensureImage: async () => {},
      installSignalHandler: (h) => {
        handler = h;
        return () => {};
      },
      logger: { info: () => {}, warn: () => {} },
    });

    await waitFor(() => rec.calls.length >= 1);
    const argv = rec.calls[0]!.join(' ');
    expect(argv).toContain('-p 0.0.0.0:8080:8080');
    expect(argv).toContain('-p 0.0.0.0:18080:18080');

    const caddyfile = await readFile(
      path.join(home, 'share', 'acme__web.Caddyfile'),
      'utf8',
    );
    // the moved listener still proxies to Keycloak's own 8080
    expect(caddyfile).toContain(':18080 {');
    expect(caddyfile).toContain('reverse_proxy http://keycloak:8080');
    expect(caddyfile).toContain('reverse_proxy http://ws:8080');

    handler?.();
    await expect(p).resolves.toBe(0);
  });
});

describe('parseForwardPorts', () => {
  it('parses the qualified host:service:container form', () => {
    expect(parseForwardPorts('18080:keycloak:8080,15173:5173')).toEqual([
      { host: 18080, service: 'keycloak', container: 8080 },
      { host: 15173, container: 5173 },
    ]);
  });

  it('parses a comma-separated host:container list', () => {
    expect(parseForwardPorts('15173:5173,18000:8000')).toEqual([
      { host: 15173, container: 5173 },
      { host: 18000, container: 8000 },
    ]);
  });

  it('tolerates surrounding whitespace and empty segments', () => {
    expect(parseForwardPorts(' 15173:5173 , ')).toEqual([
      { host: 15173, container: 5173 },
    ]);
  });

  it('rejects a malformed entry', () => {
    expect(() => parseForwardPorts('5173')).toThrow(/expected host:container/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseForwardPorts('70000:5173')).toThrow(
      /between 1 and 65535/,
    );
  });
});
