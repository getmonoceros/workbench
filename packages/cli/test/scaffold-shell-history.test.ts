import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildComposeYaml,
  buildDevcontainerJson,
  writeScaffold,
} from '../src/create/scaffold.js';
import { resolveService, expandCuratedService } from '../src/create/catalog.js';
import type { CreateOptions } from '../src/create/types.js';

/**
 * Shell history persists across `apply` (which force-removes and
 * recreates the container). It rides the same per-feature bind
 * mechanism (ADR 0020), but always-on: no feature has to be present.
 */

const base: CreateOptions = {
  name: 'sandbox',
  languages: [],
  services: [],
};

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })),
  );
});

describe('shell-history persistence (base persistent-home)', () => {
  it('image mode: binds ~/.bash_history even with no features', () => {
    const dc = buildDevcontainerJson({
      ...base,
      runtimeVersion: '1.3.2',
    }) as { mounts?: string[] };
    expect(dc.mounts).toContain(
      'source=${localWorkspaceFolder}/home/.bash_history,target=/home/node/.bash_history,type=bind',
    );
  });

  it('compose mode: binds ~/.bash_history even with no features', () => {
    const yaml = buildComposeYaml({
      ...base,
      runtimeVersion: '1.3.2',
      services: [resolveService(expandCuratedService('postgres'))],
    });
    expect(yaml).toContain('- ../home/.bash_history:/home/node/.bash_history');
  });

  it('writeScaffold seeds an empty home/.bash_history when missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mono-hist-'));
    tmpDirs.push(dir);
    await writeScaffold({ ...base, runtimeVersion: '1.3.2' }, dir);
    const histFile = path.join(dir, 'home', '.bash_history');
    expect(await fs.readFile(histFile, 'utf8')).toBe('');
  });

  it('writeScaffold does not truncate an existing history on re-apply', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mono-hist-'));
    tmpDirs.push(dir);
    const opts: CreateOptions = { ...base, runtimeVersion: '1.3.2' };
    await writeScaffold(opts, dir);
    const histFile = path.join(dir, 'home', '.bash_history');
    await fs.writeFile(histFile, 'ls -la\ngit status\n');
    await writeScaffold(opts, dir);
    expect(await fs.readFile(histFile, 'utf8')).toBe('ls -la\ngit status\n');
  });
});
