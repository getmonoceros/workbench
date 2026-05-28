import { describe, expect, it } from 'vitest';
import {
  buildDockerArgs,
  runTunnel,
  SOCAT_IMAGE,
  type DockerSpawnHandle,
} from '../src/tunnel/run.js';

describe('buildDockerArgs', () => {
  it('emits the host:port-mapping with the chosen address and the pinned socat image', () => {
    const args = buildDockerArgs({
      localAddress: '127.0.0.1',
      localPort: 5433,
      internalPort: 5432,
      network: 'demo_devcontainer_default',
      targetHost: 'postgres',
    });
    expect(args).toEqual([
      'run',
      '--rm',
      '-i',
      '--network=demo_devcontainer_default',
      '-p',
      '127.0.0.1:5433:5432',
      SOCAT_IMAGE,
      'TCP-LISTEN:5432,fork,reuseaddr',
      'TCP:postgres:5432',
    ]);
  });

  it('uses 0.0.0.0 binding for LAN exposure', () => {
    const args = buildDockerArgs({
      localAddress: '0.0.0.0',
      localPort: 3000,
      internalPort: 3000,
      network: 'monoceros-proxy',
      targetHost: 'demo',
    });
    expect(args).toContain('0.0.0.0:3000:3000');
  });
});

describe('runTunnel', () => {
  it('defaults --local-port to the resolved internal port and --local-address to 127.0.0.1', async () => {
    let receivedArgs: string[] | null = null;
    const exit = await runTunnel({
      name: 'demo',
      target: 'postgres',
      monocerosHome: '/unused',
      resolve: async () => ({
        network: 'demo_devcontainer_default',
        targetHost: 'postgres',
        internalPort: 5432,
        display: 'demo/postgres',
      }),
      preflight: async () => undefined,
      dockerSpawn: (args) => {
        receivedArgs = args;
        return makeHandle(0);
      },
      installSignalHandler: noopSignal,
      logger: silentLogger(),
    });

    expect(exit).toBe(0);
    expect(receivedArgs).toContain('127.0.0.1:5432:5432');
    expect(receivedArgs).toContain('TCP:postgres:5432');
  });

  it('treats docker exit-code 130 (SIGINT) as a clean stop (0)', async () => {
    const exit = await runTunnel({
      name: 'demo',
      target: 'postgres',
      resolve: async () => ({
        network: 'n',
        targetHost: 'postgres',
        internalPort: 5432,
        display: 'demo/postgres',
      }),
      preflight: async () => undefined,
      dockerSpawn: () => makeHandle(130),
      installSignalHandler: noopSignal,
      logger: silentLogger(),
    });
    expect(exit).toBe(0);
  });

  it('surfaces a non-zero docker exit verbatim', async () => {
    const exit = await runTunnel({
      name: 'demo',
      target: 'postgres',
      resolve: async () => ({
        network: 'n',
        targetHost: 'postgres',
        internalPort: 5432,
        display: 'demo/postgres',
      }),
      preflight: async () => undefined,
      dockerSpawn: () => makeHandle(125),
      installSignalHandler: noopSignal,
      logger: silentLogger(),
    });
    expect(exit).toBe(125);
  });

  it('passes through --local-port and --local-address to the docker -p mapping', async () => {
    let receivedArgs: string[] | null = null;
    await runTunnel({
      name: 'demo',
      target: 'postgres',
      localPort: 15432,
      localAddress: '0.0.0.0',
      resolve: async () => ({
        network: 'n',
        targetHost: 'postgres',
        internalPort: 5432,
        display: 'demo/postgres',
      }),
      preflight: async () => undefined,
      dockerSpawn: (args) => {
        receivedArgs = args;
        return makeHandle(0);
      },
      installSignalHandler: noopSignal,
      logger: silentLogger(),
    });
    expect(receivedArgs).toContain('0.0.0.0:15432:5432');
  });

  it('rejects an invalid --local-address before docker is spawned', async () => {
    let spawned = false;
    await expect(
      runTunnel({
        name: 'demo',
        target: 'postgres',
        localAddress: 'not-an-address',
        resolve: async () => ({
          network: 'n',
          targetHost: 'postgres',
          internalPort: 5432,
          display: 'demo/postgres',
        }),
        preflight: async () => undefined,
        dockerSpawn: () => {
          spawned = true;
          return makeHandle(0);
        },
        installSignalHandler: noopSignal,
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/Invalid --local-address/);
    expect(spawned).toBe(false);
  });

  it('runs preflight before spawning docker', async () => {
    const order: string[] = [];
    await runTunnel({
      name: 'demo',
      target: 'postgres',
      resolve: async () => ({
        network: 'n',
        targetHost: 'postgres',
        internalPort: 5432,
        display: 'demo/postgres',
      }),
      preflight: async ({ port, address }) => {
        order.push(`preflight:${address}:${port}`);
      },
      dockerSpawn: () => {
        order.push('docker');
        return makeHandle(0);
      },
      installSignalHandler: noopSignal,
      logger: silentLogger(),
    });
    expect(order).toEqual(['preflight:127.0.0.1:5432', 'docker']);
  });
});

function makeHandle(exitCode: number): DockerSpawnHandle {
  return {
    exited: Promise.resolve(exitCode),
    kill: () => undefined,
  };
}

function noopSignal(_handler: () => void): () => void {
  return () => undefined;
}

function silentLogger() {
  return { info: () => undefined, warn: () => undefined };
}
