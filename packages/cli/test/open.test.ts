import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPEN_TOOLS, runOpen } from '../src/open/index.js';
import { sshConfigEntryPath } from '../src/devcontainer/ssh-attach.js';

let home: string;

const silentLogger = { info: () => {}, warn: () => {} };

// docker ps lookup stub: returns a running container id, or empty.
const lookup = (running: boolean) => async () => ({
  stdout: running ? 'abc123def456\n' : '',
  stderr: '',
  exitCode: 0,
});

async function writeSshEntry(name: string): Promise<void> {
  const entry = sshConfigEntryPath(home, name);
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, `Host monoceros-${name}\n`);
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'mono-open-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('runOpen', () => {
  it('exposes code, codium and shell as tools', () => {
    expect(OPEN_TOOLS).toEqual(['code', 'codium', 'shell']);
  });

  it('delegates the shell tool to the shell runner', async () => {
    let got: { root: string; name?: string } | undefined;
    const code = await runOpen({
      name: 'demo',
      tool: 'shell',
      monocerosHome: home,
      logger: silentLogger,
      shellRunner: async (o) => {
        got = o;
        return 7;
      },
    });
    expect(code).toBe(7);
    expect(got?.name).toBe('demo');
    expect(got?.root).toBe(path.join(home, 'container', 'demo'));
  });

  it('rejects an unknown tool', async () => {
    await expect(
      runOpen({
        name: 'demo',
        tool: 'emacs',
        monocerosHome: home,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Unknown tool 'emacs'/);
  });

  it('rejects when SSH attach is not set up (no config.d entry)', async () => {
    await expect(
      runOpen({
        name: 'demo',
        tool: 'codium',
        monocerosHome: home,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/isn't set up.*monoceros apply demo/s);
  });

  it('rejects when the container is not running', async () => {
    await writeSshEntry('demo');
    await expect(
      runOpen({
        name: 'demo',
        tool: 'codium',
        monocerosHome: home,
        logger: silentLogger,
        dockerLookup: lookup(false),
      }),
    ).rejects.toThrow(/isn't running/);
  });

  it('launches the editor with the remote .code-workspace file-uri', async () => {
    await writeSshEntry('demo');
    let launched: { bin: string; args: readonly string[] } | undefined;
    const code = await runOpen({
      name: 'demo',
      tool: 'code',
      monocerosHome: home,
      logger: silentLogger,
      dockerLookup: lookup(true),
      binResolver: () => '/usr/bin/code',
      launch: (bin, args) => {
        launched = { bin, args };
      },
    });
    expect(code).toBe(0);
    expect(launched?.bin).toBe('/usr/bin/code');
    expect(launched?.args).toEqual([
      '--file-uri',
      'vscode-remote://ssh-remote+monoceros-demo/workspaces/demo/demo.code-workspace',
    ]);
  });

  it('rejects with a setup hint when the editor binary is not found', async () => {
    await writeSshEntry('demo');
    await expect(
      runOpen({
        name: 'demo',
        tool: 'code',
        monocerosHome: home,
        logger: silentLogger,
        dockerLookup: lookup(true),
        binResolver: () => null,
      }),
    ).rejects.toThrow(/VS Code.*not found.*Remote-SSH/s);
  });
});
