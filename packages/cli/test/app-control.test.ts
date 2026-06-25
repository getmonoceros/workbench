import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { hasWantedApps } from '../src/devcontainer/app-control.js';

let home: string;

function runDir(name: string, appRel: string): string {
  return path.join(home, 'container', name, '.monoceros', 'run', appRel);
}

async function writePid(
  name: string,
  appRel: string,
  target: string,
): Promise<void> {
  const dir = runDir(name, appRel);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${target}.pid`), '1234');
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'monoceros-appctl-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('hasWantedApps', () => {
  it('is false when the run dir does not exist', async () => {
    expect(await hasWantedApps('acme', home)).toBe(false);
  });

  it('is false when the run dir has no pid files', async () => {
    await mkdir(runDir('acme', 'web'), { recursive: true });
    expect(await hasWantedApps('acme', home)).toBe(false);
  });

  it('is true when a top-level app has a pid file', async () => {
    await writePid('acme', 'web', 'dev');
    expect(await hasWantedApps('acme', home)).toBe(true);
  });

  it('is true when a nested app has a pid file', async () => {
    await writePid('acme', 'services/api', 'server');
    expect(await hasWantedApps('acme', home)).toBe(true);
  });

  it('ignores non-pid files in the run dir', async () => {
    const dir = runDir('acme', 'web');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'dev.log'), 'noise');
    expect(await hasWantedApps('acme', home)).toBe(false);
  });
});
