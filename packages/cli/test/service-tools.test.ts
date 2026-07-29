import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeServiceTools } from '../src/create/scaffold.js';
import {
  curatedServiceTools,
  resolveService,
  expandCuratedService,
} from '../src/create/catalog.js';
import type { ResolvedService } from '../src/create/types.js';

const svc = (name: string, image = `${name}:test`): ResolvedService =>
  resolveService({ name, image });

describe('curatedServiceTools', () => {
  it('lists keycloak-realm for keycloak and nothing for the others', () => {
    expect(curatedServiceTools('keycloak')).toEqual(['keycloak-realm']);
    expect(curatedServiceTools('postgres')).toEqual([]);
    // A custom image Monoceros knows nothing about.
    expect(curatedServiceTools('acme-thing')).toEqual([]);
  });
});

describe('writeServiceTools', () => {
  let monocerosDir: string;

  beforeEach(async () => {
    monocerosDir = await mkdtemp(path.join(tmpdir(), 'monoceros-tools-'));
  });

  afterEach(async () => {
    await rm(monocerosDir, { recursive: true, force: true });
  });

  it('copies a configured service tool into bin/ and makes it executable', async () => {
    await writeServiceTools(
      [resolveService(expandCuratedService('keycloak'))],
      monocerosDir,
    );
    const tool = path.join(monocerosDir, 'bin', 'keycloak-realm');
    const body = await readFile(tool, 'utf8');
    expect(body.startsWith('#!/usr/bin/env bash')).toBe(true);
    // The script must not accept a target URL: that is what keeps it from
    // ever being aimed at staging (it reads KEYCLOAK_URL from the env).
    expect(body).toContain('KEYCLOAK_URL');
    const mode = (await stat(tool)).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('writes no bin/ for a container whose services contribute no tool', async () => {
    await writeServiceTools([svc('postgres', 'postgres:18')], monocerosDir);
    await expect(stat(path.join(monocerosDir, 'bin'))).rejects.toThrow(
      /ENOENT/,
    );
  });

  it('removes a stale bin/ when the contributing service leaves the yml', async () => {
    const binDir = path.join(monocerosDir, 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      path.join(binDir, 'keycloak-realm'),
      '# from an earlier apply',
    );
    await writeServiceTools([svc('postgres', 'postgres:18')], monocerosDir);
    await expect(stat(binDir)).rejects.toThrow(/ENOENT/);
  });
});
