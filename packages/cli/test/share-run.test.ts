import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runShare } from '../src/share/run.js';
import type { DockerSpawn, DockerSpawnHandle } from '../src/tunnel/run.js';
import type { ResolvedTarget } from '../src/tunnel/resolve.js';
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

const preflightStub = async (): Promise<void> => {};
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
      preflight: preflightStub,
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
      preflight: preflightStub,
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

  it('throws when the app has no launch config', async () => {
    await expect(
      runShare({
        name: 'acme',
        app: 'ghost',
        monocerosHome: home,
        dockerSpawn: recordingSpawn().spawn,
        resolve: resolveStub,
        preflight: preflightStub,
        hostAddresses: hostStub,
      }),
    ).rejects.toThrow(/No launch config/);
  });

  it('throws when no target declares a port', async () => {
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
        preflight: preflightStub,
        hostAddresses: hostStub,
      }),
    ).rejects.toThrow(/nothing to share/);
  });
});
