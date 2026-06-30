import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runInit } from '../src/init/index.js';
import { parseConfig } from '../src/config/index.js';
import { writeDescriptor } from './helpers/fake-workbench.js';

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
  // README sentinel so workbenchRoot() — if ever called — finds a marker.
  const componentsDir = path.join(root, 'templates', 'components');
  await mkdir(componentsDir, { recursive: true });
  await writeFile(path.join(componentsDir, 'README.md'), '# components\n');

  await writeDescriptor(
    root,
    'languages',
    'node',
    [
      'id: node',
      'category: language',
      'displayName: Node 22',
      'description: Node runtime.',
      'language:',
      '  feature: ghcr.io/devcontainers/features/node:1',
      '  builtin: true',
      '',
    ].join('\n'),
  );
  await writeDescriptor(
    root,
    'services',
    'postgres',
    [
      'id: postgres',
      'category: service',
      'displayName: Postgres 16',
      'description: Postgres compose service.',
      'service:',
      '  image: postgres:18',
      '  defaultPort: 5432',
      '',
    ].join('\n'),
  );
  // Selector `claude` (short name), manifest id `claude-code`. The manifest
  // summary init renders (option hints, usage notes) is derived from this
  // descriptor — `apiKey` is a surface:env hint, plus a usage note.
  await writeDescriptor(
    root,
    'features',
    'claude-code',
    [
      'id: claude-code',
      'name: claude',
      'category: feature',
      'displayName: Claude Code CLI',
      'description: Claude Code CLI feature.',
      'usageNotes:',
      '  - Persistent OAuth login lives at home/.claude in the container, so first-run `claude login` survives apply rebuilds.',
      'options:',
      '  apiKey:',
      '    type: string',
      "    default: ''",
      '    description: Optional Anthropic API key. When set, exported as ANTHROPIC_API_KEY for all shells in the container.',
      '    surface: env',
      'feature:',
      '  version: 1.0.0',
      '',
    ].join('\n'),
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
    // node is builtin; init surfaces its base-image version inline (node:22),
    // which stays builtin at apply (no upstream feature install).
    expect(parsed.config.languages).toEqual(['node:22']);
  });

  it('surfaces a language’s yml options as the object form (java → Maven/Gradle)', async () => {
    const result = await runInit({
      name: 'jbox',
      languages: ['java:21', 'node'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    // java surfaces its surface:yml defaults as the object form; the version
    // moves inside. node has no surface:yml options → stays a bare string.
    expect(text).toMatch(
      /languages:\n {2}- java:\n {6}version: 21\n {6}installMaven: true\n {6}installGradle: true\n {2}- node:22\n/,
    );
    // Round-trips through the schema into the object form.
    const parsed = parseConfig(text);
    expect(parsed.config.languages).toEqual([
      { java: { version: 21, installMaven: true, installGradle: true } },
      'node:22',
    ]);
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
    // No `restart:` policy on curated services (issue #19) so the whole
    // compose group stays down after a Docker/host restart until `start`.
    expect(yml).not.toContain('restart:');
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

  it('no --with-* flag writes a lean default: basics only, no catalog dump', async () => {
    const result = await runInit({
      name: 'sandbox',
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    expect(text).toContain('schemaVersion: 1');
    expect(text).toContain('name: sandbox');
    expect(text).toMatch(/^runtimeVersion:/m);
    // No commented catalog dump of unused categories.
    expect(text).not.toContain('# languages:');
    expect(text).not.toContain('# services:');
    expect(text).not.toContain('# features:');
    expect(text).not.toContain('# repos:');
    // ...and no active blocks either (nothing was requested).
    expect(text).not.toMatch(/^languages:/m);
    expect(text).not.toMatch(/^services:/m);
    expect(text).not.toMatch(/^features:/m);
    expect(text).not.toMatch(/^repos:/m);
    // git.user only appears once a repo is configured.
    expect(text).not.toMatch(/^git:/m);
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

  it('--with-repos alone writes a lean yml: active repos + git, no catalog dump', async () => {
    const result = await runInit({
      name: 'sandbox',
      withRepo: ['https://github.com/foo/bar.git'],
      workbenchRoot: root,
      monocerosHome,
      logger: silentLogger,
    });
    const text = await readFile(result.configPath, 'utf8');
    expect(text).toMatch(/^repos:/m);
    expect(text).toContain('- url: https://github.com/foo/bar.git');
    // git identity block appears because a repo is configured.
    expect(text).toMatch(/^git:/m);
    // No commented catalog dump of the other categories.
    expect(text).not.toContain('# languages:');
    expect(text).not.toContain('# features:');
    expect(text).not.toContain('# services:');
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
