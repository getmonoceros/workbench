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
      '    - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
      '',
    ].join('\n'),
  );

  // Matching feature manifest with optionHints + a description on
  // the hinted option + a per-feature usageNote — exercises the
  // full hint-rendering surface that the init generator consumes.
  const featureDir = path.join(root, 'images', 'features', 'claude-code');
  await mkdir(featureDir, { recursive: true });
  await writeFile(
    path.join(featureDir, 'devcontainer-feature.json'),
    JSON.stringify(
      {
        id: 'claude-code',
        version: '1.0.0',
        options: {
          apiKey: {
            type: 'string',
            default: '',
            description:
              'Optional Anthropic API key. When set, exported as ANTHROPIC_API_KEY for all shells in the container.',
          },
        },
        'x-monoceros': {
          optionHints: ['apiKey'],
          usageNotes: [
            'Persistent OAuth login lives at home/.claude in the container, so first-run `claude login` survives apply rebuilds.',
          ],
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
    expect(text).toContain(
      '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
    );
    // optionHints rendered as commented hints next to options:
    expect(text).toMatch(/#\s+apiKey:/);
    // x-monoceros.usageNotes is rendered as a comment block right
    // above the matching `- ref:` line.
    expect(text).toMatch(
      /#\s+Persistent OAuth login[\s\S]*\n\s+- ref: ghcr\.io\/getmonoceros\/monoceros-features\/claude-code:1/,
    );
    // The option's description shows up just above the hint line.
    expect(text).toMatch(/#\s+Optional Anthropic API key[\s\S]*#\s+apiKey:/);
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
    // Repos section appears as a documented hint block too — same
    // "all available options visible" rule that drives the features
    // block above.
    expect(text).toContain('# repos:');
    expect(text).toContain('#     # path:');
    expect(text).toContain('#     # provider: github');
    expect(text).toContain('#     # git:');
    expect(text).toMatch(/#\s+- node\s+# Node 22/);
    expect(text).toContain(
      '#   - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
    );
    // Documented mode still validates as a SolutionConfig — every
    // section is commented out so only schemaVersion + name remain
    // active.
    const parsed = parseConfig(text);
    expect(parsed.config.name).toBe('sandbox');
  });

  it('--with-repo: clones into composed yml with URL-derived path', async () => {
    const result = await runInit({
      name: 'sandbox',
      with: ['node'],
      withRepo: ['https://github.com/foo/bar.git'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    expect(text).toContain('repos:');
    expect(text).toContain('- url: https://github.com/foo/bar.git');
    // The per-entry hint block surfaces the optional fields as
    // commented lines so the builder sees what's available without
    // leaving the file. `path:` MUST appear as a commented hint
    // (with the URL-derived default echoed in the trailing comment)
    // and MUST NOT appear as an active key.
    expect(text).toMatch(/# path: bar/);
    expect(text).not.toMatch(/^ {4}path:/m);
    const parsed = parseConfig(text);
    expect(parsed.config.repos).toHaveLength(1);
    expect(parsed.config.repos[0]!.url).toBe('https://github.com/foo/bar.git');
    // The commented hints must not leak into the parsed model.
    expect(parsed.config.repos[0]!.path).toBeUndefined();
    expect(parsed.config.repos[0]!.provider).toBeUndefined();
    expect(parsed.config.repos[0]!.git).toBeUndefined();
  });

  it('--with-repo: renders commented hint lines for the optional fields on each entry', async () => {
    const result = await runInit({
      name: 'sandbox',
      with: ['node'],
      withRepo: ['https://github.com/foo/bar.git'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    // The per-entry block must surface all optional fields the
    // schema accepts (path, provider, git.user) as commented hints
    // so the builder discovers them without leaving the file.
    expect(text).toMatch(/^ {4}# path: bar\b/m);
    expect(text).toMatch(/^ {4}# provider: github\b/m);
    expect(text).toMatch(/^ {4}# git:\s*#/m);
    expect(text).toMatch(/^ {4}#\s+user:/m);
    expect(text).toMatch(/^ {4}#\s+name: Your Name/m);
    expect(text).toMatch(/^ {4}#\s+email: you@example\.com/m);
  });

  it('--with-repo: multiple URLs all land in repos, in order', async () => {
    const result = await runInit({
      name: 'sandbox',
      with: ['node'],
      withRepo: [
        'https://github.com/foo/api.git',
        'https://github.com/foo/ui.git',
      ],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    const parsed = parseConfig(text);
    expect(parsed.config.repos.map((r) => r.url)).toEqual([
      'https://github.com/foo/api.git',
      'https://github.com/foo/ui.git',
    ]);
  });

  it('--with-repo: same URL passed twice → single entry (idempotent)', async () => {
    const result = await runInit({
      name: 'sandbox',
      with: ['node'],
      withRepo: [
        'https://github.com/foo/bar.git',
        'https://github.com/foo/bar.git',
      ],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    const parsed = parseConfig(text);
    expect(parsed.config.repos).toHaveLength(1);
  });

  it('--with-repo: works in documented mode (no --with) too', async () => {
    const result = await runInit({
      name: 'sandbox',
      withRepo: ['https://github.com/foo/bar.git'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    // Documented mode is reported by the documented flag.
    expect(result.documented).toBe(true);
    const text = await readFile(result.configPath, 'utf8');
    // The repos block is active even though the rest is commented.
    expect(text).toMatch(/^repos:/m);
    expect(text).toContain('- url: https://github.com/foo/bar.git');
  });

  it('--with-repo: rejects non-canonical hosts pointing to add-repo --provider', async () => {
    // Self-hosted GitLab / Gitea / corporate domains: we can't tell
    // the provider from the URL, and init has no --provider flag.
    // Fail loudly so the builder doesn't end up with an unappliable
    // yml that fails at pre-flight.
    await expect(
      runInit({
        name: 'sandbox',
        withRepo: ['https://git.firma.de/team/app.git'],
        workbenchRoot: root,
        monocerosHome,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/git\.firma\.de[\s\S]*add-repo[\s\S]*--provider/);
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
