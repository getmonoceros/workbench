import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  generateDeployMd,
  hasDeployBriefing,
} from '../src/briefing/deploy-md.js';
import { resolveService } from '../src/create/catalog.js';
import type { ResolvedService } from '../src/create/types.js';

const svc = (name: string, image: string): ResolvedService =>
  resolveService({ name, image });

/** Every ```yaml block in the rendered file, in order. */
function yamlBlocks(md: string): string[] {
  return [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

describe('generateDeployMd', () => {
  it('returns null when no configured service has a deploy block', () => {
    expect(generateDeployMd([])).toBeNull();
    // Every curated service carries a block, so only a custom image yields
    // no parts list at all.
    expect(generateDeployMd([svc('weird', 'acme/weird:1')])).toBeNull();
  });

  it('renders a service block with the image the container actually runs', () => {
    const md = generateDeployMd([svc('postgres', 'postgres:19-rc')])!;
    expect(md).toContain('## postgres');
    // The descriptor block carries the catalog tag, but a per-container
    // image override replaces it, so dev and pipeline cannot drift.
    expect(md).toContain('image: postgres:19-rc');
    expect(md).not.toContain('image: postgres:18');
  });

  it('renders the block under a renamed instance key', () => {
    const md = generateDeployMd([svc('postgres', 'postgres:18')])!;
    const [block] = yamlBlocks(md);
    expect(block!.startsWith('postgres:\n')).toBe(true);
  });

  it('produces a block that parses as compose and keeps the guidance comments', () => {
    const md = generateDeployMd([svc('postgres', 'postgres:18')])!;
    const [block] = yamlBlocks(md);

    const parsed = parse(`services:\n${indent(block!)}`) as {
      services: Record<string, Record<string, unknown>>;
    };
    const pg = parsed.services.postgres!;
    expect(pg.image).toBe('postgres:18');
    // The pipeline shape: no volume, and a healthcheck that only passes
    // once TCP is up (see the descriptor's deploy block).
    expect(pg.volumes).toBeUndefined();
    expect(pg.healthcheck).toMatchObject({
      test: expect.arrayContaining(['pg_isready', '-h', '127.0.0.1']),
    });
    // Every value comes from the pipeline: required, never defaulted.
    expect(pg.environment).toMatchObject({
      POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?set it as a pipeline secret}',
    });
    // The few comments the block does carry survive into the file.
    expect(block).toContain('# No volume:');
  });

  it('renders what a service needs beside itself as a second, top-level fragment', () => {
    const md = generateDeployMd([
      svc('keycloak', 'quay.io/keycloak/keycloak:26.6'),
    ])!;
    expect(md).toContain('It needs these of its own:');
    const [own, requires] = yamlBlocks(md);
    expect(own!.startsWith('keycloak:\n')).toBe(true);
    // Keycloak points at its own database, so the URL is a literal and only
    // the credentials are secrets.
    expect(own).toContain(
      'KC_DB_URL: jdbc:postgresql://keycloak-db:5432/keycloak',
    );

    // The fragment carries top-level keys, because a named volume only
    // exists when it is declared there.
    const parsed = parse(requires!) as {
      services: Record<string, Record<string, unknown>>;
      volumes: Record<string, unknown>;
    };
    expect(Object.keys(parsed.services)).toEqual(['keycloak-db']);
    expect(Object.keys(parsed.volumes)).toEqual(['keycloak-db-data']);
    expect(parsed.services['keycloak-db']!.volumes).toEqual([
      'keycloak-db-data:/var/lib/postgresql',
    ]);
  });

  it('renders no such fragment for a service that needs nothing extra', () => {
    const md = generateDeployMd([svc('postgres', 'postgres:18')])!;
    expect(md).not.toContain('It needs these of its own:');
    expect(yamlBlocks(md)).toHaveLength(1);
  });

  it('names every service that has no block, so none reads as "nothing needed"', () => {
    const md = generateDeployMd([
      svc('postgres', 'postgres:18'),
      svc('weird', 'acme/weird:1'),
      svc('other', 'acme/other:2'),
    ])!;
    expect(md).toContain('## Without a block');
    expect(md).toContain('No block on file for `weird` and `other`');
    // Only the curated service gets a block.
    expect(yamlBlocks(md)).toHaveLength(1);
  });
});

describe('hasDeployBriefing', () => {
  it('is true only when a configured service contributes a block', () => {
    expect(hasDeployBriefing([])).toBe(false);
    expect(hasDeployBriefing([svc('weird', 'acme/weird:1')])).toBe(false);
    expect(hasDeployBriefing([svc('redis', 'redis:8')])).toBe(true);
    expect(hasDeployBriefing([svc('postgres', 'postgres:18')])).toBe(true);
  });
});

/** Indent a service block so it nests under a `services:` key. */
function indent(block: string): string {
  return block
    .split('\n')
    .map((l) => (l.trim() ? `  ${l}` : l))
    .join('\n');
}
