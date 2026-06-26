import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runShare } from '../src/share/run.js';
import type { DockerSpawn, DockerSpawnHandle } from '../src/tunnel/run.js';
import type { ResolvedTarget } from '../src/tunnel/resolve.js';

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
      installSignalHandler: (h) => {
        handler = h;
        return () => {};
      },
      logger: { info: (m) => lines.push(m), warn: () => {} },
    });

    await waitFor(() => rec.calls.length >= 2);

    // one socat sidecar per ported target (5173, 3001) — not the port-less worker
    expect(rec.calls).toHaveLength(2);
    const flat = rec.calls.map((a) => a.join(' '));
    expect(flat.some((a) => a.includes('-p 0.0.0.0:5173:5173'))).toBe(true);
    expect(flat.some((a) => a.includes('-p 0.0.0.0:3001:3001'))).toBe(true);
    expect(flat.every((a) => a.includes('--network=net'))).toBe(true);
    // banner mentions the host + both ports
    const banner = lines.join('\n');
    expect(banner).toContain('192.168.1.10:5173');
    expect(banner).toContain('192.168.1.10:3001');

    // Ctrl+C tears every forward down and the command returns clean
    handler?.();
    for (const h of rec.handles) expect(h.kill).toHaveBeenCalledWith('SIGTERM');
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
