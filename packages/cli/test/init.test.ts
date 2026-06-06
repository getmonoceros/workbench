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

  it('composed mode: --with-languages/services/features writes an active yml that validates', async () => {
    const result = await runInit({
      name: 'sandbox',
      languages: ['node'],
      services: ['postgres'],
      features: ['claude'],
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
    // Pinned runtime version (ADR 0017) — written active, not commented.
    expect(text).toMatch(/^runtimeVersion: \d+\.\d+\.\d+$/m);
    expect(text).toContain('languages:');
    expect(text).toContain('  - node');
    expect(text).toContain('services:');
    expect(text).toContain('  - name: postgres');
    expect(text).toContain('    image: postgres:18');
    expect(text).toContain(
      '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
    );
    // In composed mode the credential option hints land as ACTIVE
    // `${VAR}` placeholders in the options block (empty/missing resolves
    // to "" at apply → transform skips → default inherited). The matching
    // env var is seeded blank into <name>.env.
    expect(text).toMatch(/^\s+options:\s*$/m);
    expect(text).toMatch(/^\s+apiKey: \$\{CLAUDE_CODE_API_KEY\}\s*$/m);
    expect(text).not.toMatch(/^[# \t]*#[ \t]+#/m); // no two-`#` per line anywhere
    // Header comment block above the `- ref:` line carries the
    // feature's manifest description verbatim and lists its options
    // synthesized from `optionDescriptions`.
    expect(text).toMatch(/^# Options: apiKey \(/m);
    const parsed = parseConfig(text);
    expect(parsed.config.name).toBe('sandbox');
    expect(parsed.config.languages).toEqual(['node']);
  });

  it('writes a gitignored <name>.env stub with an info header', async () => {
    await runInit({
      name: 'sandbox',
      languages: ['node'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const envText = await readFile(
      path.join(monocerosHome, 'container-configs', 'sandbox.env'),
      'utf8',
    );
    expect(envText).toMatch(/Secrets and values for \$\{VAR\}/);
    expect(envText).toContain('sandbox.yml');
    // the gitignore guard also covers it
    const gi = await readFile(
      path.join(monocerosHome, 'container-configs', '.gitignore'),
      'utf8',
    );
    expect(gi).toContain('*.env');
  });

  it('renders ${VAR} feature hints in the yml and seeds them into <name>.env', async () => {
    await runInit({
      name: 'sandbox',
      features: ['claude'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const yml = await readFile(
      path.join(monocerosHome, 'container-configs', 'sandbox.yml'),
      'utf8',
    );
    // Active placeholder (not commented) — empty .env seed → unset at apply.
    expect(yml).toMatch(/^\s+apiKey: \$\{CLAUDE_CODE_API_KEY\}\s*$/m);
    expect(yml).not.toMatch(/#\s+apiKey:/);
    const env = await readFile(
      path.join(monocerosHome, 'container-configs', 'sandbox.env'),
      'utf8',
    );
    expect(env).toMatch(/^CLAUDE_CODE_API_KEY=$/m);
  });

  it('renders ${VAR} env placeholders for curated services and seeds their dev-defaults into <name>.env', async () => {
    await runInit({
      name: 'sandbox',
      services: ['postgres'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const yml = await readFile(
      path.join(monocerosHome, 'container-configs', 'sandbox.yml'),
      'utf8',
    );
    expect(yml).toContain('POSTGRES_USER: ${POSTGRES_USER}');
    expect(yml).toContain('restart: unless-stopped');
    const env = await readFile(
      path.join(monocerosHome, 'container-configs', 'sandbox.env'),
      'utf8',
    );
    expect(env).toMatch(/^POSTGRES_USER=monoceros$/m);
    expect(env).toMatch(/^POSTGRES_PASSWORD=monoceros$/m);
    expect(env).toMatch(/^POSTGRES_DB=monoceros$/m);
  });

  it('never clobbers an existing <name>.env', async () => {
    const envPath = path.join(
      monocerosHome,
      'container-configs',
      'sandbox.env',
    );
    await mkdir(path.dirname(envPath), { recursive: true });
    await writeFile(envPath, 'PG_PASSWORD=keep-me\n');
    await runInit({
      name: 'sandbox',
      languages: ['node'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    expect(await readFile(envPath, 'utf8')).toBe('PG_PASSWORD=keep-me\n');
  });

  it('documented mode: no --with-* flag writes a default with every component commented out', async () => {
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
    // Repos section appears as a documented hint block, fully
    // single-`#` commented. Optional fields show as plain `#` lines
    // — NO nested `# # ...` and no trailing `# default:` chatter.
    expect(text).toContain('# repos:');
    expect(text).toMatch(/^#\s+path: <folder>\s*$/m);
    expect(text).toMatch(/^#\s+provider: github\s*$/m);
    expect(text).toMatch(/^#\s+git:\s*$/m);
    // No two-`#` per line anywhere — builder must strip exactly one
    // `#` per line to activate any commented block.
    expect(text).not.toMatch(/^#[ \t]+#[ \t]/m);
    expect(text).toMatch(/^#\s+- node\s*$/m);
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
      languages: ['node'],
      withRepo: ['https://github.com/foo/bar.git'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    expect(text).toContain('repos:');
    expect(text).toContain('- url: https://github.com/foo/bar.git');
    // Optional per-entry fields surface as single-`#` commented hints
    // under each active repo URL — builder strips one `#` per line
    // to set a value. Discoverability from inside the file.
    expect(text).toMatch(/^ {4}# path:\s*$/m);
    expect(text).toMatch(/^ {4}# provider:\s*$/m);
    expect(text).toMatch(/^ {4}# git:\s*$/m);
    expect(text).toMatch(/^ {4}#\s+user:\s*$/m);
    expect(text).toMatch(/^ {4}#\s+name:\s*$/m);
    expect(text).toMatch(/^ {4}#\s+email:\s*$/m);
    // Hints must NOT leak into the parsed model.
    expect(text).not.toMatch(/^ {4}path:/m);
    const parsed = parseConfig(text);
    expect(parsed.config.repos).toHaveLength(1);
    expect(parsed.config.repos[0]!.url).toBe('https://github.com/foo/bar.git');
    expect(parsed.config.repos[0]!.path).toBeUndefined();
    expect(parsed.config.repos[0]!.provider).toBeUndefined();
    expect(parsed.config.repos[0]!.git).toBeUndefined();
  });

  it('--with-repo: multiple URLs all land in repos, in order', async () => {
    const result = await runInit({
      name: 'sandbox',
      languages: ['node'],
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
      languages: ['node'],
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

  it('--with-ports: writes an active routing block, first entry default', async () => {
    const result = await runInit({
      name: 'sandbox',
      languages: ['node'],
      withPorts: [3000, 5173, 6006],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    expect(text).toContain('routing:');
    // Each port on its own line, no trailing inline comments.
    expect(text).toMatch(/^\s+- 3000\s*$/m);
    expect(text).toMatch(/^\s+- 5173\s*$/m);
    expect(text).toMatch(/^\s+- 6006\s*$/m);
    expect(text).not.toMatch(/^\s+-\s+\d+[ \t]+#/m); // no trailing-comment on a port line
    // vscodeAutoForward appears as a commented hint so the surface is
    // discoverable with one keystroke — single `#` depth, no trailing
    // explanation.
    expect(text).toMatch(/^\s+#\s+vscodeAutoForward: false\s*$/m);
    const parsed = parseConfig(text);
    expect(parsed.config.routing?.ports).toEqual([3000, 5173, 6006]);
    expect(parsed.config.routing?.vscodeAutoForward).toBeUndefined();
  });

  it('--with-ports: works in documented mode too (replaces the hint block)', async () => {
    const result = await runInit({
      name: 'sandbox',
      withPorts: [3000],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    // Active routing block is present...
    expect(text).toMatch(/^routing:\s*$/m);
    expect(text).toMatch(/^\s+- 3000\s*$/m);
    // ...and the documented-mode hint comments are NOT (otherwise
    // we'd be writing both).
    expect(text).not.toMatch(/^#\s+routing:\s*$/m);
  });

  it('--with-ports: dedupes repeated values, preserving order', async () => {
    const result = await runInit({
      name: 'sandbox',
      languages: ['node'],
      withPorts: [3000, 5173, 3000, 6006],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const parsed = parseConfig(await readFile(result.configPath, 'utf8'));
    expect(parsed.config.routing?.ports).toEqual([3000, 5173, 6006]);
  });

  it('--with-ports: rejects out-of-range values with a usage error', async () => {
    await expect(
      runInit({
        name: 'sandbox',
        languages: ['node'],
        withPorts: [70000],
        workbenchRoot: root,
        monocerosHome,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Invalid port in --with-ports: 70000/);
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

  it('errors on an unknown language, listing the known runtimes', async () => {
    await expect(
      runInit({
        name: 'sandbox',
        languages: ['node', 'cobol'],
        workbenchRoot: root,
        monocerosHome,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Unknown language.*cobol[\s\S]*Known:.*node/);
  });

  it('errors on an unknown feature short name, pointing at catalog + OCI ref', async () => {
    await expect(
      runInit({
        name: 'sandbox',
        features: ['nope'],
        workbenchRoot: root,
        monocerosHome,
        logger: silentLogger,
      }),
    ).rejects.toThrow(/Unknown feature.*nope[\s\S]*OCI ref/);
  });

  it('accepts a full OCI ref as a feature (not just catalog short names)', async () => {
    const result = await runInit({
      name: 'sandbox',
      features: ['ghcr.io/devcontainers/features/go:1'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    expect(text).toContain('  - ref: ghcr.io/devcontainers/features/go:1');
  });

  it('expands a curated service and scaffolds a custom image in composed mode', async () => {
    const result = await runInit({
      name: 'sandbox',
      services: ['postgres', 'rustfs/rustfs:latest'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    // curated → full block
    expect(text).toContain('  - name: postgres');
    expect(text).toContain('    image: postgres:18');
    // custom image → name + image active + commented scaffold
    expect(text).toContain('  - name: rustfs');
    expect(text).toContain('    image: rustfs/rustfs:latest');
    expect(text).toMatch(/^\s+#\s*port:/m);
  });

  it('writes an active aptPackages block from --with-apt-packages', async () => {
    const result = await runInit({
      name: 'sandbox',
      aptPackages: ['openssl', 'make'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    expect(result.documented).toBe(false);
    const text = await readFile(result.configPath, 'utf8');
    expect(text).toMatch(/^aptPackages:/m);
    expect(text).toContain('  - openssl');
    expect(text).toContain('  - make');
    const parsed = parseConfig(text);
    expect(parsed.config.aptPackages).toEqual(['openssl', 'make']);
  });

  it('errors when the target config already exists', async () => {
    await runInit({
      name: 'sandbox',
      languages: ['node'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    await expect(
      runInit({
        name: 'sandbox',
        languages: ['node'],
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
        languages: ['node'],
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
          languages: ['node'],
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
