import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveTunnelTarget } from '../src/tunnel/resolve.js';
import { composeProjectName } from '../src/devcontainer/compose.js';
import type { DockerExec } from '../src/proxy/index.js';

describe('resolveTunnelTarget', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-tunnel-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
    await mkdir(path.join(home, 'container'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeYml(name: string, body: string): Promise<void> {
    await writeFile(path.join(home, 'container-configs', `${name}.yml`), body);
  }

  async function materializeContainer(
    name: string,
    opts: { compose?: boolean } = {},
  ): Promise<string> {
    const root = path.join(home, 'container', name);
    await mkdir(path.join(root, '.devcontainer'), { recursive: true });
    if (opts.compose) {
      await writeFile(
        path.join(root, '.devcontainer', 'compose.yaml'),
        'services:\n  workspace:\n    image: stub\n',
      );
    }
    return root;
  }

  it('refuses without an yml profile', async () => {
    await expect(
      resolveTunnelTarget({
        name: 'missing',
        target: 'postgres',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/No yml profile/);
  });

  it('refuses without a materialised container directory', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      resolveTunnelTarget({
        name: 'demo',
        target: '8080',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/not materialised/);
  });

  it('refuses an unconfigured service, listing the configured ones', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await materializeContainer('demo', { compose: true });
    await expect(
      resolveTunnelTarget({
        name: 'demo',
        target: 'mongo',
        monocerosHome: home,
      }),
    ).rejects.toThrow(
      /Service 'mongo' is not configured.*\(none configured\)/s,
    );
  });

  it('refuses a service not declared in the yml, listing what is configured', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: redis',
        '    image: redis:8',
        '',
      ].join('\n'),
    );
    await materializeContainer('demo', { compose: true });
    await expect(
      resolveTunnelTarget({
        name: 'demo',
        target: 'postgres',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/not configured in this container's yml.*redis/s);
  });

  it('resolves a custom (non-catalog) service via its declared port', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: rustfs',
        '    image: rustfs/rustfs:latest',
        '    port: 9000',
        '',
      ].join('\n'),
    );
    const root = await materializeContainer('demo', { compose: true });
    const resolved = await resolveTunnelTarget({
      name: 'demo',
      target: 'rustfs',
      monocerosHome: home,
    });
    expect(resolved).toEqual({
      network: `${composeProjectName(root)}_default`,
      targetHost: 'rustfs',
      internalPort: 9000,
      display: 'demo/rustfs:9000',
    });
  });

  it('refuses a custom service that declares no port', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: rustfs',
        '    image: rustfs/rustfs:latest',
        '',
      ].join('\n'),
    );
    await materializeContainer('demo', { compose: true });
    await expect(
      resolveTunnelTarget({
        name: 'demo',
        target: 'rustfs',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/declares no port/);
  });

  it('resolves <service>:<port> to that service on the explicit port', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: rustfs',
        '    image: rustfs/rustfs:latest',
        '    port: 9000',
        '',
      ].join('\n'),
    );
    const root = await materializeContainer('demo', { compose: true });
    // 9001 (the console) — different from the declared 9000.
    const resolved = await resolveTunnelTarget({
      name: 'demo',
      target: 'rustfs:9001',
      monocerosHome: home,
    });
    expect(resolved).toEqual({
      network: `${composeProjectName(root)}_default`,
      targetHost: 'rustfs',
      internalPort: 9001,
      display: 'demo/rustfs:9001',
    });
  });

  it('<service>:<port> works even when the service declares no port', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: rustfs',
        '    image: rustfs/rustfs:latest',
        '',
      ].join('\n'),
    );
    await materializeContainer('demo', { compose: true });
    const resolved = await resolveTunnelTarget({
      name: 'demo',
      target: 'rustfs:9001',
      monocerosHome: home,
    });
    expect(resolved.internalPort).toBe(9001);
    expect(resolved.targetHost).toBe('rustfs');
  });

  it('refuses <service>:<port> when the service is not configured', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await materializeContainer('demo', { compose: true });
    await expect(
      resolveTunnelTarget({
        name: 'demo',
        target: 'mongo:27017',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/not configured/);
  });

  it('rejects <service>:<bad-port>', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: rustfs',
        '    image: rustfs/rustfs:latest',
        '    port: 9000',
        '',
      ].join('\n'),
    );
    await materializeContainer('demo', { compose: true });
    await expect(
      resolveTunnelTarget({
        name: 'demo',
        target: 'rustfs:nope',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Invalid target/);
  });

  it('compose + service → compose network and service-name DNS', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: postgres',
        '    image: postgres:18',
        '    port: 5432',
        '',
      ].join('\n'),
    );
    const root = await materializeContainer('demo', { compose: true });
    const resolved = await resolveTunnelTarget({
      name: 'demo',
      target: 'postgres',
      monocerosHome: home,
    });
    expect(resolved).toEqual({
      network: `${composeProjectName(root)}_default`,
      targetHost: 'postgres',
      internalPort: 5432,
      display: 'demo/postgres:5432',
    });
  });

  it('compose + port → compose network targeting the workspace service', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const root = await materializeContainer('demo', { compose: true });
    const resolved = await resolveTunnelTarget({
      name: 'demo',
      target: '8080',
      monocerosHome: home,
    });
    expect(resolved).toEqual({
      network: `${composeProjectName(root)}_default`,
      targetHost: 'workspace',
      internalPort: 8080,
      display: 'demo:8080',
    });
  });

  it('image-mode + service → refuses (services need compose mode)', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: postgres',
        '    image: postgres:18',
        '    port: 5432',
        '',
      ].join('\n'),
    );
    await materializeContainer('demo'); // no compose.yaml
    await expect(
      resolveTunnelTarget({
        name: 'demo',
        target: 'postgres',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/image-mode \(no compose.yaml\)/);
  });

  it('image-mode + port + routing.ports → monoceros-proxy network with name alias', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '',
      ].join('\n'),
    );
    await materializeContainer('demo'); // image-mode
    const resolved = await resolveTunnelTarget({
      name: 'demo',
      target: '8080',
      monocerosHome: home,
    });
    expect(resolved).toEqual({
      network: 'monoceros-proxy',
      targetHost: 'demo',
      internalPort: 8080,
      display: 'demo:8080',
    });
  });

  it('image-mode + port without routing.ports → inspects container, uses bridge IP', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const root = await materializeContainer('demo'); // image-mode, no ports

    const dockerCalls: string[][] = [];
    const docker: DockerExec = async (args) => {
      dockerCalls.push(args);
      if (args[0] === 'ps') {
        expect(args).toContain(`label=devcontainer.local_folder=${root}`);
        return { stdout: 'deadbeef1234\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'inspect') {
        expect(args[args.length - 1]).toBe('deadbeef1234');
        return {
          stdout: JSON.stringify({
            bridge: { IPAddress: '172.17.0.5' },
          }),
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`unexpected docker call: ${args.join(' ')}`);
    };

    const resolved = await resolveTunnelTarget({
      name: 'demo',
      target: '8080',
      monocerosHome: home,
      docker,
    });

    expect(resolved).toEqual({
      network: 'bridge',
      targetHost: '172.17.0.5',
      internalPort: 8080,
      display: 'demo:8080',
    });
    expect(dockerCalls).toHaveLength(2);
  });

  it('image-mode + no running container → actionable error', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await materializeContainer('demo');
    const docker: DockerExec = async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    await expect(
      resolveTunnelTarget({
        name: 'demo',
        target: '8080',
        monocerosHome: home,
        docker,
      }),
    ).rejects.toThrow(/No running container/);
  });

  it('image-mode + container with no usable network → clear error', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await materializeContainer('demo');
    const docker: DockerExec = async (args) => {
      if (args[0] === 'ps') {
        return { stdout: 'abc123\n', stderr: '', exitCode: 0 };
      }
      // No IP in any network.
      return {
        stdout: JSON.stringify({ bridge: { IPAddress: '' } }),
        stderr: '',
        exitCode: 0,
      };
    };
    await expect(
      resolveTunnelTarget({
        name: 'demo',
        target: '8080',
        monocerosHome: home,
        docker,
      }),
    ).rejects.toThrow(/no network with a reachable IP/);
  });
});
