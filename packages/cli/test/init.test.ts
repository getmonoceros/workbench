import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/init/index.js';
import { parseConfig } from '../src/config/index.js';

const silentLogger = {
  success: () => {},
  info: () => {},
};

/**
 * Build a tmp "workbench root" with a tiny components catalog and
 * a couple of matching feature manifests under images/features/.
 * The init tests don't need the full real workbench — just enough
 * structure for the catalog reader, generator, and manifest loader
 * to do their thing.
 */
async function buildFakeWorkbench(root: string): Promise<void> {
  const componentsDir = path.join(root, 'templates', 'components');
  await mkdir(componentsDir, { recursive: true });
  // README sentinel so workbenchRoot() — if it were ever called —
  // would find a marker. We pass workbenchRoot explicitly in the
  // tests, but the file is cheap and matches the real layout.
  await writeFile(path.join(componentsDir, 'README.md'), '# components\n');

  await writeFile(
    path.join(componentsDir, 'node.yml'),
    [
      'displayName: Node 22',
      'description: Node runtime.',
      'category: language',
      'contributes:',
      '  languages: [node]',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(componentsDir, 'postgres.yml'),
    [
      'displayName: Postgres 16',
      'description: Postgres compose service.',
      'category: service',
      'contributes:',
      '  services: [postgres]',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(componentsDir, 'claude.yml'),
    [
      'displayName: Claude Code CLI',
      'description: Claude Code CLI feature.',
      'category: feature',
      'contributes:',
      '  features:',
      '    - ref: ghcr.io/monoceros/features/claude-code:1',
      '',
    ].join('\n'),
  );

  // Matching feature manifest with optionHints.
  const featureDir = path.join(root, 'images', 'features', 'claude-code');
  await mkdir(featureDir, { recursive: true });
  await writeFile(
    path.join(featureDir, 'devcontainer-feature.json'),
    JSON.stringify(
      {
        id: 'claude-code',
        version: '1.0.0',
        options: {
          apiKey: { type: 'string', default: '' },
        },
        'x-monoceros': {
          optionHints: ['apiKey'],
        },
      },
      null,
      2,
    ),
  );
}

describe('runInit', () => {
  let root: string;
  let monocerosHome: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-init-'));
    monocerosHome = path.join(root, '.local');
    await buildFakeWorkbench(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('composed mode: --with=node,postgres,claude writes an active yml that validates', async () => {
    const result = await runInit({
      name: 'sandbox',
      with: ['node', 'postgres', 'claude'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    expect(result.documented).toBe(false);
    expect(result.configPath).toBe(
      path.join(monocerosHome, 'container-configs', 'sandbox.yml'),
    );
    const text = await readFile(result.configPath, 'utf8');
    expect(text).toContain('name: sandbox');
    expect(text).toContain('languages:');
    expect(text).toContain('  - node');
    expect(text).toContain('services:');
    expect(text).toContain('  - postgres');
    expect(text).toContain('  - ref: ghcr.io/monoceros/features/claude-code:1');
    // optionHints rendered as commented hints next to options:
    expect(text).toMatch(/#\s+apiKey:/);
    const parsed = parseConfig(text);
    expect(parsed.config.name).toBe('sandbox');
    expect(parsed.config.languages).toEqual(['node']);
  });

  it('documented mode: no --with writes a default with every component commented out', async () => {
    const result = await runInit({
      name: 'sandbox',
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    expect(result.documented).toBe(true);
    const text = await readFile(result.configPath, 'utf8');
    expect(text).toContain('name: sandbox');
    // No active section — only commented examples.
    expect(text).not.toMatch(/^languages:/m);
    expect(text).not.toMatch(/^services:/m);
    expect(text).not.toMatch(/^features:/m);
    expect(text).toContain('# languages:');
    expect(text).toContain('# services:');
    expect(text).toContain('# features:');
    expect(text).toMatch(/#\s+- node\s+# Node 22/);
    expect(text).toContain(
      '#   - ref: ghcr.io/monoceros/features/claude-code:1',
    );
    // Documented mode still validates as a SolutionConfig — every
    // section is commented out so only schemaVersion + name remain
    // active.
    const parsed = parseConfig(text);
    expect(parsed.config.name).toBe('sandbox');
  });

  it("errors when --with names a component that's not in the catalog, listing alternatives", async () => {
    await expect(
      runInit({
        name: 'sandbox',
        with: ['node', 'rust'],
        workbenchRoot: root,
        monocerosHome,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Unknown component: rust[\s\S]*claude.*node.*postgres/);
  });

  it('errors when the target config already exists', async () => {
    await runInit({
      name: 'sandbox',
      with: ['node'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    await expect(
      runInit({
        name: 'sandbox',
        with: ['node'],
        workbenchRoot: root,
        monocerosHome,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/already exists/);
  });

  it('rejects an invalid config name without writing anything', async () => {
    await expect(
      runInit({
        name: 'has space',
        with: ['node'],
        workbenchRoot: root,
        monocerosHome,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Invalid config name/);
  });

  it('errors when the workbench has no components catalog', async () => {
    const emptyRoot = await mkdtemp(
      path.join(tmpdir(), 'monoceros-init-empty-'),
    );
    try {
      await expect(
        runInit({
          name: 'sandbox',
          with: ['node'],
          workbenchRoot: emptyRoot,
          monocerosHome: path.join(emptyRoot, '.local'),
          logger: silentLogger,
        }),
      ).rejects.toThrow(/No components/);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});
