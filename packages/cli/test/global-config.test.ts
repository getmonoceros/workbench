import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMachineSettings } from '../src/config/global.js';

/**
 * Machine-global settings live in `monoceros-config.env` (ADR 0061), and a
 * legacy `monoceros-config.yml` is migrated into it once, by whichever command
 * reads the settings first.
 */

let home: string;
let notices: string[];
const envPath = (): string => path.join(home, 'monoceros-config.env');
const ymlPath = (): string => path.join(home, 'monoceros-config.yml');
const read = () =>
  readMachineSettings({
    monocerosHome: home,
    notify: (m) => notices.push(m),
  });

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'monoceros-machine-'));
  notices = [];
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('readMachineSettings', () => {
  it('falls back to the defaults without a global env', async () => {
    expect(await read()).toEqual({ hostPort: 80, upgradeStaleDays: 30 });
    expect(notices).toEqual([]);
  });

  it('reads the host port and the upgrade nudge from the env', async () => {
    await writeFile(
      envPath(),
      'MONOCEROS_HOST_PORT=8080\nMONOCEROS_UPGRADE_STALE_DAYS=14\n',
    );
    expect(await read()).toEqual({ hostPort: 8080, upgradeStaleDays: 14 });
  });

  it('treats a blank value as unset', async () => {
    await writeFile(envPath(), 'MONOCEROS_HOST_PORT=\n');
    expect((await read()).hostPort).toBe(80);
  });

  // A port the builder typed on purpose must not silently become 80.
  it('rejects a value that is not a port, and names the key and the file', async () => {
    await writeFile(envPath(), 'MONOCEROS_HOST_PORT=eighty\n');
    await expect(read()).rejects.toThrow(
      /MONOCEROS_HOST_PORT in .*monoceros-config\.env must be a whole number from 1 to 65535, got "eighty"/,
    );
  });
});

describe('migrating a legacy monoceros-config.yml', () => {
  it('retires a yml that holds only defaults, and moves nothing', async () => {
    await writeFile(
      ymlPath(),
      [
        'schemaVersion: 1',
        'defaults:',
        '  git:',
        '    user:',
        "      name: ''",
        "      email: ''",
        '  features:',
        'routing:',
        '  hostPort: 80',
        '',
      ].join('\n'),
    );
    await read();
    expect(existsSync(ymlPath())).toBe(false);
    expect(existsSync(`${ymlPath()}.migrated`)).toBe(true);
    expect(existsSync(envPath())).toBe(false);
    expect(notices[0]).toMatch(/only default values/);
  });

  it('moves every changed value into the env, once', async () => {
    await writeFile(
      ymlPath(),
      [
        'schemaVersion: 1',
        'defaults:',
        '  git:',
        '    user:',
        '      name: Ada Lovelace',
        '      email: ada@example.com',
        'routing:',
        '  hostPort: 8080',
        'upgrade:',
        '  staleDays: 14',
        '',
      ].join('\n'),
    );
    expect(await read()).toEqual({ hostPort: 8080, upgradeStaleDays: 14 });

    const env = await readFile(envPath(), 'utf8');
    expect(env).toMatch(/^MONOCEROS_HOST_PORT=8080$/m);
    expect(env).toMatch(/^MONOCEROS_UPGRADE_STALE_DAYS=14$/m);
    expect(env).toMatch(/^GIT_USER_NAME=Ada Lovelace$/m);
    expect(env).toMatch(/^GIT_USER_EMAIL=ada@example.com$/m);
    expect(notices[0]).toMatch(/routing\.hostPort -> MONOCEROS_HOST_PORT/);
    expect(notices[0]).toMatch(/monoceros-config\.yml\.migrated/);

    // The second run finds no yml and says nothing.
    notices = [];
    await read();
    expect(notices).toEqual([]);
  });

  it('keeps what the env already sets and says the yml value was dropped', async () => {
    await writeFile(envPath(), 'MONOCEROS_HOST_PORT=9090\n');
    await writeFile(
      ymlPath(),
      'schemaVersion: 1\nrouting:\n  hostPort: 8080\n',
    );
    expect((await read()).hostPort).toBe(9090);
    expect(notices[0]).toMatch(/Already set .*dropped/);
    expect(notices[0]).toMatch(
      /MONOCEROS_HOST_PORT \(from routing\.hostPort\)/,
    );
  });

  it('moves a credential under the variable the workbench yml references, and lists the rest', async () => {
    await writeFile(
      ymlPath(),
      [
        'schemaVersion: 1',
        'defaults:',
        '  features:',
        '    ghcr.io/getmonoceros/monoceros-features/claude-code:1:',
        '      apiKey: sk-ant-secret',
        '      permissionMode: ask',
        '    ghcr.io/acme/features/thing:1:',
        '      flavour: spicy',
        '',
      ].join('\n'),
    );
    await read();
    const env = await readFile(envPath(), 'utf8');
    expect(env).toMatch(/^CLAUDE_CODE_API_KEY=sk-ant-secret$/m);
    // A yml-surfaced option and a third-party one have no place in the env.
    expect(env).not.toMatch(/permissionMode|flavour/);
    expect(notices[0]).toMatch(
      /claude-code:1: permissionMode: ask[\s\S]*thing:1: flavour: spicy/,
    );
    // A moved value may be a token, so it is never printed.
    expect(notices[0]).not.toContain('sk-ant-secret');
  });

  it('stops on a yml it cannot read, and leaves the file where it is', async () => {
    await writeFile(ymlPath(), 'schemaVersion: 1\n  bad: indent\n');
    await expect(read()).rejects.toThrow(
      /Could not migrate .*monoceros-config\.yml/,
    );
    expect(existsSync(ymlPath())).toBe(true);
  });
});
