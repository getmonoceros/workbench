import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The block every shipped service version writes into a workbench yml, pinned
 * (ADR 0066). `upgrade` rebuilds what the recorded version wrote and merges
 * from there, so a version whose block changes in place hands every workbench
 * on it a wrong base, and their edits get overwritten or misreported.
 *
 * When this fails because you changed `components/services/<id>/component.yml`:
 * restore the old file as `component@<n>.yml` next to it (n = its version),
 * raise `version` in `component.yml`, then add the new version's hash here.
 */
const PINS: Record<string, Record<number, string>> = {
  caddy: { 1: '1930bc176717' },
  keycloak: { 1: 'a7e70a095161' },
  mailpit: { 1: '70bf4862a74d' },
  mongodb: { 1: 'c9e410738571' },
  mssql: { 1: '61d95f69a343' },
  mysql: { 1: 'b42ccd74698e' },
  pgvector: { 1: '0959f5f4949f' },
  postgres: { 1: '21656b5d7038' },
  redis: { 1: 'ea7c5e880af0' },
  rustfs: { 1: '96f551afbddf' },
};

let home: string;
let saved: string | undefined;

beforeAll(async () => {
  // An empty home, so the catalog is the shipped one alone.
  home = await mkdtemp(path.join(os.tmpdir(), 'monoceros-pins-'));
  saved = process.env.MONOCEROS_HOME;
  process.env.MONOCEROS_HOME = home;
  vi.resetModules();
});

afterAll(async () => {
  if (saved === undefined) delete process.env.MONOCEROS_HOME;
  else process.env.MONOCEROS_HOME = saved;
  vi.resetModules();
  await rm(home, { recursive: true, force: true });
});

describe('shipped service versions', () => {
  it('write the block they wrote when they were released', async () => {
    const catalog = await import('../src/create/catalog.js');
    const actual: Record<string, Record<number, string>> = {};
    for (const id of catalog.knownServices()) {
      actual[id] = {};
      for (let v = 1; v <= catalog.currentServiceVersion(id)!; v++) {
        const entry = catalog.serviceEntryAt(id, v);
        if (!entry) continue;
        actual[id][v] = createHash('sha256')
          .update(JSON.stringify(catalog.expandServiceEntry(entry)))
          .digest('hex')
          .slice(0, 12);
      }
    }
    expect(actual).toEqual(PINS);
  });
});
