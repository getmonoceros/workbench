import { promises as fs, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runAddAptPackages,
  runAddFeature,
  runAddFromUrl,
  runAddLanguage,
  runAddPort,
  runAddRepo,
  runAddService,
  runRemoveAptPackages,
  runRemoveFeature,
  runRemoveFromUrl,
  runRemoveLanguage,
  runRemovePort,
  runRemoveRepo,
  runRemoveService,
} from '../src/modify/index.js';
import { parseConfig } from '../src/config/index.js';
import { solutionConfigToCreateOptions } from '../src/config/transform.js';
import { serviceConnectionEnv } from '../src/create/catalog.js';

const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
};

// Stub the docker exec the proxy module reaches for in runAddPort /
// runRemovePort. Reports "everything exists and is running" so the
// happy paths don't actually spawn a docker process during yml-only
// unit tests. Returning OK with empty stdout from `network inspect`
// makes maybeStopProxy see an empty network and proceed through its
// rm calls — also OK-stubbed.
const noopProxyDocker = async () => ({
  stdout: 'true\n',
  stderr: '',
  exitCode: 0,
});

// Stub the docker exec runAddRepo uses to look up a running container
// for the on-the-fly-clone path. Empty stdout makes
// `findRunningContainerByLocalFolder` see no match, so the flow exits
// through the "container not running" branch without spawning a real
// `docker ps`. Default-applied on `baseOpts` so every test (notably
// the runAddRepo cases that don't exercise the on-the-fly flow) stays
// off the host docker daemon and out of the CI timeout window.
const noopContainerLookupDocker = async () => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
});

const baseOpts = {
  yes: true,
  logger: silentLogger,
  confirm: async () => true,
  output: () => {},
  containerLookupDocker: noopContainerLookupDocker,
};

const portOpts = { ...baseOpts, proxyDocker: noopProxyDocker };

describe('add-*/remove-* against the yml', () => {
  let home: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'monoceros-modify-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
  });

  afterEach(() => {
    if (home && existsSync(home))
      rmSync(home, { recursive: true, force: true });
  });

  async function writeYml(name: string, yml: string): Promise<void> {
    await writeFile(path.join(home, 'container-configs', `${name}.yml`), yml);
  }
  async function ymlOf(name: string): Promise<string> {
    return fs.readFile(
      path.join(home, 'container-configs', `${name}.yml`),
      'utf8',
    );
  }

  // ─── add-* ────────────────────────────────────────────────────────

  it('runAddLanguage appends and preserves the comment block', async () => {
    await writeYml('demo', '# my notes\nschemaVersion: 1\nname: demo\n');
    const result = await runAddLanguage({
      ...baseOpts,
      name: 'demo',
      language: 'python',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('# my notes');
    expect(yml).toContain('languages:');
    // node-less language with no surface:yml options → bare string, but the
    // default version is surfaced inline (matches init).
    expect(yml).toContain('- python:latest');
  });

  it('runAddLanguage surfaces the object form for a language with yml options (java)', async () => {
    await writeYml('jdemo', 'schemaVersion: 1\nname: jdemo\n');
    const result = await runAddLanguage({
      ...baseOpts,
      name: 'jdemo',
      language: 'java:21',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const parsed = parseConfig(await ymlOf('jdemo'));
    // Same object form `init` produces — version inline + surface:yml options.
    expect(parsed.config.languages).toEqual([
      { java: { version: '21', installMaven: true, installGradle: true } },
    ]);
  });

  it('runAddLanguage is idempotent by language name (java vs java:21)', async () => {
    await writeYml(
      'idem',
      'schemaVersion: 1\nname: idem\nlanguages:\n  - java:17\n',
    );
    const result = await runAddLanguage({
      ...baseOpts,
      name: 'idem',
      language: 'java',
      monocerosHome: home,
    });
    // java already present (as java:17) → no-op, the existing pin is kept.
    expect(result.status).toBe('no-change');
    expect(parseConfig(await ymlOf('idem')).config.languages).toEqual([
      'java:17',
    ]);
  });

  it('runAddService expands a curated name into a full object block', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runAddService({
      ...baseOpts,
      name: 'demo',
      service: 'postgres',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('- name: postgres');
    expect(yml).toContain('image: postgres:18');
    expect(yml).toContain('port: 5432');
    // env renders as ${VAR} placeholders; the literal dev-defaults are
    // seeded into <name>.env instead of baked into the shareable yml.
    expect(yml).toContain('POSTGRES_USER: ${POSTGRES_USER}');
    expect(yml).toContain('- data:/var/lib/postgresql');
    // No `restart:` policy on curated services (issue #19) so the whole
    // compose group stays down after a Docker/host restart until `start`.
    expect(yml).not.toContain('restart:');
    expect(yml).toMatch(/healthcheck:/);
    const env = await fs.readFile(
      path.join(home, 'container-configs', 'demo.env'),
      'utf8',
    );
    expect(env).toContain('POSTGRES_USER=monoceros');
    expect(env).toContain('POSTGRES_PASSWORD=monoceros');
    expect(env).toContain('POSTGRES_DB=monoceros');
  });

  it('runAddService keycloak: deferred command + commented volumes scaffold (ADR 0025)', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runAddService({
      ...baseOpts,
      name: 'demo',
      service: 'keycloak',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('- name: keycloak');
    expect(yml).toContain('command: start-dev --import-realm');
    // The example volumes ride as a COMMENTED scaffold — the `volumes:` key
    // is commented too, because an active but empty `volumes:` parses to
    // null and apply rejects it.
    expect(yml).toMatch(/#\s*volumes:/);
    expect(yml).toContain('/opt/keycloak/data/import/<app>.json:ro');
    expect(yml).toContain('/opt/keycloak/themes/<app>');
    // No active (null) volumes key leaked in — the yml still validates.
    const { validateConfig } = await import('../src/config/schema.js');
    const { parse } = await import('yaml');
    expect(() => validateConfig(parse(yml))).not.toThrow();
  });

  it('runAddService scaffolds a custom image with name + commented hints', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runAddService({
      ...baseOpts,
      name: 'demo',
      service: 'rustfs/rustfs:latest',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    // active fields
    expect(yml).toContain('- name: rustfs');
    expect(yml).toContain('image: rustfs/rustfs:latest');
    // commented scaffold survives the AST round-trip
    expect(yml).toMatch(/#\s*port:/);
    expect(yml).toMatch(/#\s*env:/);
    // the yml still validates (custom service = name + image is enough)
    const { validateConfig } = await import('../src/config/schema.js');
    const { parse } = await import('yaml');
    expect(() => validateConfig(parse(yml))).not.toThrow();
  });

  it('runAddService --as adds the same curated image twice under distinct names', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddService({
      ...baseOpts,
      name: 'demo',
      service: 'postgres',
      as: 'postgres-app',
      monocerosHome: home,
    });
    const second = await runAddService({
      ...baseOpts,
      name: 'demo',
      service: 'postgres',
      as: 'postgres-analytics',
      monocerosHome: home,
    });
    expect(second.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('- name: postgres-app');
    expect(yml).toContain('- name: postgres-analytics');
    // both carry the expanded catalog block, neither keeps the bare
    // catalog name `postgres`
    expect(yml).not.toMatch(/- name: postgres$/m);
    expect(yml.match(/image: postgres:18/g)).toHaveLength(2);
    // Each instance must SERIALISE its own connectionEnv block, so the
    // templates travel through the yml and resolve per instance at apply.
    // (Regression: renderServiceObjectBody dropped connectionEnv, so a
    // renamed instance hit the catalog-by-name fallback, missed, and got
    // no connection env at all.) Drive the real apply pipeline:
    // parse → transform → serviceConnectionEnv.
    expect(yml.match(/connectionEnv:/g)).toHaveLength(2);
    const parsed = parseConfig(yml);
    const opts = solutionConfigToCreateOptions(parsed.config, {});
    const env = serviceConnectionEnv(opts.services);
    expect(env.POSTGRES_APP_URL).toContain('@postgres-app:5432/');
    expect(env.POSTGRES_ANALYTICS_URL).toContain('@postgres-analytics:5432/');
    expect(env.POSTGRES_APP_URL).not.toBe(env.POSTGRES_ANALYTICS_URL);
  });

  it('runAddService rejects an invalid --as name', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddService({
        ...baseOpts,
        name: 'demo',
        service: 'postgres',
        as: 'Bad Name',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Invalid --as name/);
  });

  it('runAddService errors on a name collision with a different image', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: rustfs',
        '    image: rustfs/rustfs:latest',
        '',
      ].join('\n'),
    );
    await expect(
      runAddService({
        ...baseOpts,
        name: 'demo',
        service: 'rustfs/rustfs:v2',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/already exists with a different image/);
  });

  it('runAddService is a no-op when the service is already present', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: postgres',
        '    image: postgres:18',
        '',
      ].join('\n'),
    );
    const result = await runAddService({
      ...baseOpts,
      name: 'demo',
      service: 'postgres',
      monocerosHome: home,
    });
    expect(result.status).toBe('no-change');
  });

  it('runAddAptPackages appends only the new packages and preserves inline comments', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'aptPackages:',
        '  - make # build essential',
        '  - jq',
        '',
      ].join('\n'),
    );
    const result = await runAddAptPackages({
      ...baseOpts,
      name: 'demo',
      packages: ['jq', 'curl'],
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('# build essential');
    expect(yml).toContain('- curl');
    expect(yml.match(/- jq\b/g)).toHaveLength(1);
  });

  it('runAddFromUrl appends to installUrls', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFromUrl({
      ...baseOpts,
      name: 'demo',
      url: 'https://example.com/install',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('installUrls:');
    expect(yml).toContain('- https://example.com/install');
  });

  it('runAddFeature writes a structured entry with options', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      options: { version: 'latest' },
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain(
      '- ref: ghcr.io/devcontainers/features/docker-in-docker:2',
    );
    expect(yml).toContain('options:');
    expect(yml).toContain('version: latest');
  });

  it('runAddFeature accepts a catalog short-name and pulls its default options', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain(
      '- ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1',
    );
    expect(yml).toContain('rovodev: true');
    expect(yml).toContain('twg: true');
  });

  it('runAddFeature renders ${VAR} option hints and seeds them into <name>.env', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    // ACTIVE ${VAR} placeholders in the options block (not commented)
    expect(yml).toMatch(/^\s+instance: \$\{ATLASSIAN_INSTANCE\}\s*$/m);
    expect(yml).toMatch(/^\s+apiToken: \$\{ATLASSIAN_API_TOKEN\}\s*$/m);
    expect(yml).toMatch(
      /^\s+bitbucketToken: \$\{ATLASSIAN_BITBUCKET_TOKEN\}\s*$/m,
    );
    expect(yml).not.toMatch(/#\s+apiToken:/);
    // …and the same vars seeded into the env file
    const env = await fs.readFile(
      path.join(home, 'container-configs', 'demo.env'),
      'utf8',
    );
    expect(env).toMatch(/^ATLASSIAN_INSTANCE=$/m);
    expect(env).toMatch(/^ATLASSIAN_EMAIL=$/m);
    expect(env).toMatch(/^ATLASSIAN_API_TOKEN=$/m);
    expect(env).toMatch(/^ATLASSIAN_BITBUCKET_TOKEN=$/m);
  });

  it('runAddFeature resolves a sub-component short-name (atlassian/twg)', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian/twg',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain(
      '- ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1',
    );
    // Sub-component's options-block opts out of rovodev, in to twg.
    expect(yml).toContain('rovodev: false');
    expect(yml).toContain('twg: true');
  });

  it('runAddFeature short-name + `--` options merges with overrides winning', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian',
      options: { rovodev: false, instance: 'foo.atlassian.net' },
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    // User override wins over catalog default (rovodev: true).
    expect(yml).toContain('rovodev: false');
    // Catalog default that wasn't overridden survives.
    expect(yml).toContain('twg: true');
    // Extra key supplied only by the user lands as-is.
    expect(yml).toContain('instance: foo.atlassian.net');
  });

  it('runAddFeature errors on an unknown short-name and lists available features', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddFeature({
        ...baseOpts,
        name: 'demo',
        ref: 'nonexistent-feature',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Unknown feature: "nonexistent-feature"/);
  });

  it('runAddFeature redirects to add-language when given a language short-name', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddFeature({
        ...baseOpts,
        name: 'demo',
        ref: 'node',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/'node' is a language, not a feature[\s\S]*add-language/);
  });

  it('runAddFeature errors when re-adding a plain feature with different options', async () => {
    // Plain feature / raw ref keeps the overwrite-protected behavior: once
    // it's in the yml, re-adding with different options is an error.
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      options: { version: 'latest' },
      monocerosHome: home,
    });
    await expect(
      runAddFeature({
        ...baseOpts,
        name: 'demo',
        ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
        options: { version: '20.10' },
        monocerosHome: home,
      }),
    ).rejects.toThrow(/different options/);
  });

  it('runAddFeature "different options" error echoes the user-typed short-name, not the ref', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian', // bare selector: not a preset, overwrite-protected
      monocerosHome: home,
    });
    await expect(
      runAddFeature({
        ...baseOpts,
        name: 'demo',
        ref: 'atlassian',
        options: { rovodev: false }, // different from catalog default
        monocerosHome: home,
      }),
    ).rejects.toThrow(
      /Feature atlassian is already configured[\s\S]*monoceros remove-feature atlassian/,
    );
  });

  it('runAddFeature adds a sub-tool preset into an existing entry without dropping siblings', async () => {
    // The reported case: atlassian already configured for twg only; adding
    // the forge sub-tool flips forge on and leaves twg/rovodev as they were
    // (booleans OR — true wins).
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian/twg', // rovodev:false, twg:true, forge:false
      monocerosHome: home,
    });
    const second = await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian/forge', // rovodev:false, twg:false, forge:true
      monocerosHome: home,
    });
    expect(second.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('twg: true'); // preserved — OR never clears it
    expect(yml).toContain('forge: true'); // the added sub-tool
    expect(yml).toContain('rovodev: false'); // still off (false OR false)
    // env placeholders from the original add survive the merge
    expect(yml).toMatch(/^\s+apiToken: \$\{ATLASSIAN_API_TOKEN\}\s*$/m);
  });

  it('runAddFeature re-adding the same sub-tool preset is a no-op', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian/twg',
      monocerosHome: home,
    });
    const before = await ymlOf('demo');
    const second = await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian/twg',
      monocerosHome: home,
    });
    expect(second.status).toBe('no-change');
    expect(await ymlOf('demo')).toBe(before);
  });

  it('runAddFeature on a fresh init yml keeps the routing section header at column 0', async () => {
    // Regression for a user-visible bug where init-generated yml +
    // subsequent add-feature scrambled the column-0 routing/repos
    // section header comments into the features block. The fix is
    // the centralised relocateLeakedSectionComments() pass in
    // mutate() — without that, yaml-lib's parser attaches the
    // `# Container ports exposed…` block to the previous top-level
    // pair's deepest leaf, and re-emit indents it 4 spaces inside.
    await writeYml(
      'demo',
      [
        '# Solution-config — describes what should be inside your dev-container.',
        '',
        'schemaVersion: 1',
        'name: demo',
        '',
        'features:',
        '',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        '    # options:',
        '    #   apiKey:',
        '',
        '# Container ports exposed to the host through Traefik. Reach them in your',
        '# browser as demo-<port>.localhost (e.g. demo-3000.localhost). The first',
        '# entry is the default route and is also reachable as the bare',
        '# demo.localhost. Manage the list with `monoceros add-port`.',
        'routing:',
        '  ports:',
        '    - 3000',
        '',
      ].join('\n'),
    );
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian',
      options: { apiToken: 'tok', email: 'me@example.com' },
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    // The routing section header MUST still sit at column 0 (no
    // leading whitespace) directly above `routing:` — not indented
    // inside the features block.
    expect(yml).toMatch(/^# Container ports exposed to the host/m);
    expect(yml).toMatch(/^routing:$/m);
    // No version of that header line at deeper indent.
    expect(yml).not.toMatch(/^[ \t]+# Container ports exposed/m);
  });

  it('runAddFeature attaches the manifest-driven header block above the new entry', async () => {
    // Same per-feature header (`<Name> — <description>`, options
    // summary, documentationURL) the init generator emits, so a
    // feature added via add-feature reads the same as one added via
    // `init --with-features=…`. Builders shouldn't lose context just because
    // they came in through a different entry point.
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    // Tagline + first description sentence land as commentBefore.
    expect(yml).toMatch(/^\s*# Atlassian — /m);
    // Synthesized "Options: …" summary line.
    expect(yml).toMatch(/^\s*# Options: instance \(/m);
    // documentationURL line.
    expect(yml).toMatch(/^\s*# See https:\/\/developer\.atlassian\.com/m);
    // The header sits ABOVE the dash, not interleaved with it
    // (yaml-lib's other emission mode would produce `- # Atlassian`).
    expect(yml).not.toMatch(/-\s+# Atlassian/);
  });

  it('runRemoveFeature strips the per-feature header comment, not just the ref+options', async () => {
    // Regression for a user-visible bug: yaml-lib parses the header
    // comment block that visually precedes a sequence-item as the
    // trailing `.comment` of the PREVIOUS sequence-item (separated
    // by a `\n\n` from that previous item's own inline hints).
    // splice() removes the target entry but doesn't touch the
    // previous sibling — so the header lines used to survive in the
    // previous entry's trailing comment and re-emit as orphaned
    // column-2 prose under `features:`.
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        '',
        'features:',
        '',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        '    # options:',
        '    #   apiKey:',
        '',
        '  # Atlassian — header that yaml-lib will park on the claude entry',
        '  # second line of that header.',
        '  # Options: …',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1',
        '    options:',
        '      twg: true',
        '',
      ].join('\n'),
    );
    await runRemoveFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).not.toContain('atlassian');
    expect(yml).not.toContain('Atlassian — header');
    expect(yml).not.toMatch(/^[ \t]*# Options: …/m);
    // Claude entry + its own commented options-hint must still be there.
    expect(yml).toContain('claude-code:1');
    expect(yml).toMatch(/^\s+# options:\s*$/m);
  });

  it('runRemoveFeature accepts a short-name (atlassian)', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian',
      monocerosHome: home,
    });
    await runRemoveFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'atlassian',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    // The feature block went away — only schemaVersion / name remain.
    expect(yml).not.toContain(
      'ghcr.io/getmonoceros/monoceros-features/atlassian:1',
    );
  });

  it('runAddRepo appends a repo entry, omitting redundant path', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('repos:');
    expect(yml).toContain('- url: https://github.com/foo/bar.git');
    // path matches the URL-derived default ("bar") so it's omitted as
    // an active key — but appears as a single-`#` commented hint under
    // the entry so the builder can set it later without re-reading the
    // docs. Same shape `init --with-repo=…` emits.
    expect(yml).not.toMatch(/^ {4}path:/m);
    expect(yml).toMatch(/^ {4}# path:\s*$/m);
  });

  it('runAddRepo adds the provider CLI feature to the yml (github → github-cli)', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('features:');
    expect(yml).toContain('github-cli');
  });

  it('runAddRepo adds gitlab-cli for a gitlab repo', async () => {
    await writeYml('gl', 'schemaVersion: 1\nname: gl\n');
    await runAddRepo({
      ...baseOpts,
      name: 'gl',
      url: 'https://gitlab.com/foo/bar.git',
      monocerosHome: home,
    });
    expect(await ymlOf('gl')).toContain('gitlab-cli');
  });

  it('runAddRepo scaffolds a container git.user placeholder + seeds .env for the first repo', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toMatch(/^git:/m);
    expect(yml).toContain('name: ${GIT_USER_NAME}');
    expect(yml).toContain('email: ${GIT_USER_EMAIL}');
    const env = await fs.readFile(
      path.join(home, 'container-configs', 'demo.env'),
      'utf8',
    );
    expect(env).toMatch(/^GIT_USER_NAME=$/m);
    expect(env).toMatch(/^GIT_USER_EMAIL=$/m);
  });

  it('runAddRepo leaves an existing git.user untouched', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'git:',
        '  user:',
        '    name: Existing Name',
        '    email: existing@example.com',
        '',
      ].join('\n'),
    );
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('name: Existing Name');
    expect(yml).not.toContain('${GIT_USER_NAME}');
  });

  it('runAddRepo rejects a malformed literal --git-email at the flag entry', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddRepo({
        ...baseOpts,
        name: 'demo',
        url: 'https://github.com/foo/bar.git',
        gitName: 'Me',
        gitEmail: 'not-an-email',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Invalid --git-email/);
  });

  it('runAddRepo accepts a ${VAR} placeholder for --git-email', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      gitName: '${GIT_USER_NAME}',
      gitEmail: '${GIT_USER_EMAIL}',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('email: ${GIT_USER_EMAIL}');
  });

  it('runAddRepo persists a non-default path via path option', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      path: 'apps/ui',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('path: apps/ui');
  });

  it('runAddRepo is idempotent on same url + same effective path', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      monocerosHome: home,
    });
    const result = await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      monocerosHome: home,
    });
    expect(result.status).toBe('no-change');
  });

  it('runAddRepo persists per-repo gitUser when both name + email given', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/work/api.git',
      gitName: 'Thorsten (work)',
      gitEmail: 'tk@conciso.de',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('git:');
    expect(yml).toContain('user:');
    expect(yml).toContain('name: Thorsten (work)');
    expect(yml).toContain('email: tk@conciso.de');
  });

  it('runAddRepo errors when only one of --git-name / --git-email is given', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddRepo({
        ...baseOpts,
        name: 'demo',
        url: 'https://github.com/work/api.git',
        gitName: 'me',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/git-name and --git-email must be set together/);
  });

  it('runAddRepo updates per-repo gitUser in-place when called again with different values', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/work/api.git',
      gitName: 'old',
      gitEmail: 'old@example.com',
      monocerosHome: home,
    });
    const result = await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/work/api.git',
      gitName: 'new',
      gitEmail: 'new@example.com',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('name: new');
    expect(yml).toContain('email: new@example.com');
    expect(yml).not.toContain('old@example.com');
    // Still just one repo entry — no duplicate appended.
    expect(
      yml.match(/- url: https:\/\/github\.com\/work\/api\.git/g),
    ).toHaveLength(1);
  });

  it('runAddRepo adds a second entry when same url has different path', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      monocerosHome: home,
    });
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      path: 'apps/bar-feature',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    // Two entries: the first omits path (URL-derived), the second
    // sets the explicit subfolder path.
    expect(
      yml.match(/- url: https:\/\/github\.com\/foo\/bar\.git/g),
    ).toHaveLength(2);
    expect(yml).toContain('path: apps/bar-feature');
  });

  it('runAddRepo rejects provider=gitea (Gitea is not a supported provider)', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddRepo({
        ...baseOpts,
        name: 'demo',
        url: 'https://gitea.deine-firma.de/team/app.git',
        provider: 'gitea',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/provider/i);
  });

  it('runAddRepo persists provider field for self-hosted GitLab', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://git.firma.de/team/app.git',
      provider: 'gitlab',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('- url: https://git.firma.de/team/app.git');
    expect(yml).toContain('provider: gitlab');
  });

  it('runAddRepo errors when non-canonical host has no --provider', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddRepo({
        ...baseOpts,
        name: 'demo',
        url: 'https://git.firma.de/team/app.git',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/--provider=github\|gitlab\|bitbucket/);
  });

  it('runAddRepo accepts --provider matching the canonical host (no-op write)', async () => {
    // Passing --provider=github for github.com is harmless — we just
    // don't persist the field (auto-detection would do the same).
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      provider: 'github',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('- url: https://github.com/foo/bar.git');
    // No ACTIVE `provider:` key — github.com auto-detects.
    expect(yml).not.toMatch(/^ {4}provider:/m);
    // But the commented hint still shows so the builder can override.
    expect(yml).toMatch(/^ {4}# provider:\s*$/m);
  });

  it('runAddRepo rejects --provider that contradicts the canonical host', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddRepo({
        ...baseOpts,
        name: 'demo',
        url: 'https://github.com/foo/bar.git',
        provider: 'gitlab',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/contradicts host/);
  });

  it('runAddRepo rejects an invalid --provider value', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddRepo({
        ...baseOpts,
        name: 'demo',
        url: 'https://git.firma.de/team/app.git',
        provider: 'sourcehut',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Invalid --provider/);
  });

  it('runAddRepo updates provider in-place when called again with different value', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://git.firma.de/team/app.git',
      provider: 'gitlab',
      monocerosHome: home,
    });
    const result = await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://git.firma.de/team/app.git',
      provider: 'bitbucket',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('provider: bitbucket');
    expect(yml).not.toContain('provider: gitlab');
  });

  it('runAddRepo on-the-fly: skips clone when the container is not running', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    let execCalls = 0;
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      monocerosHome: home,
      // No running container — lookup returns empty stdout, exit 0.
      containerLookupDocker: async () => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
      }),
      containerExec: async () => {
        execCalls++;
        return { exitCode: 0 };
      },
    });
    expect(execCalls).toBe(0);
  });

  it('runAddRepo on-the-fly: clones inside the container when one is running', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    // A configured token for the provider (ADR 0031) — the on-the-fly
    // clone authenticates with it, no host git tooling.
    await writeFile(
      path.join(home, 'container-configs', 'demo.env'),
      'GITHUB_API_TOKEN=tok\n',
    );
    let execCommand: string | undefined;
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      monocerosHome: home,
      containerLookupDocker: async () => ({
        stdout: 'deadbeef0001\n',
        stderr: '',
        exitCode: 0,
      }),
      containerExec: async (containerId, argv) => {
        // Capture the bash -c script body so we can assert what the
        // clone command looks like (paths, quoting, idempotency
        // guard).
        if (argv[0] === 'bash' && argv[1] === '-c') {
          execCommand = argv[2];
        }
        expect(containerId).toBe('deadbeef0001');
        return { exitCode: 0 };
      },
    });
    expect(execCommand).toBeDefined();
    // The clone is wrapped with an inline `git -c credential.helper=…`
    // so it works regardless of what post-create.sh has set globally
    // (post-create runs once at container-up; a container that
    // started life without HTTPS repos wouldn't have the helper set).
    expect(execCommand!).toMatch(
      /git -c 'credential\.helper=store --file=\/workspaces\/demo\/\.monoceros\/git-credentials' clone 'https:\/\/github\.com\/foo\/bar\.git' 'projects\/bar'/,
    );
    expect(execCommand!).toContain(`cd /workspaces/demo`);
    expect(execCommand!).toContain(`[ -d 'projects/bar' ]`);
  });

  it('runAddRepo on-the-fly: applies per-repo git.user via `git config` after clone', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await writeFile(
      path.join(home, 'container-configs', 'demo.env'),
      'GITHUB_API_TOKEN=tok\n',
    );
    let execCommand: string | undefined;
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      gitName: 'Alice Example',
      gitEmail: 'alice@example.com',
      monocerosHome: home,
      containerLookupDocker: async () => ({
        stdout: 'deadbeef0002\n',
        stderr: '',
        exitCode: 0,
      }),
      containerExec: async (_id, argv) => {
        if (argv[0] === 'bash' && argv[1] === '-c') execCommand = argv[2];
        return { exitCode: 0 };
      },
    });
    expect(execCommand!).toContain(
      `git -C 'projects/bar' config user.name 'Alice Example'`,
    );
    expect(execCommand!).toContain(
      `git -C 'projects/bar' config user.email 'alice@example.com'`,
    );
  });

  it('runAddRepo on-the-fly: skips clone but keeps yml when no token is set', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    // No <name>.env → the provider token resolves empty → no clone.
    let execCalls = 0;
    const warns: string[] = [];
    await runAddRepo({
      ...baseOpts,
      name: 'demo',
      url: 'https://github.com/foo/bar.git',
      monocerosHome: home,
      logger: {
        info: () => {},
        success: () => {},
        warn: (m) => warns.push(m),
      },
      containerLookupDocker: async () => ({
        stdout: 'deadbeef0003\n',
        stderr: '',
        exitCode: 0,
      }),
      // No <name>.env and no global token → the token resolves to
      // nothing, so the clone is skipped with a warn; the yml stays.
      containerExec: async () => {
        execCalls++;
        return { exitCode: 0 };
      },
    });
    // yml IS updated (we don't roll back); clone DID NOT run.
    const yml = await ymlOf('demo');
    expect(yml).toContain('- url: https://github.com/foo/bar.git');
    expect(execCalls).toBe(0);
    expect(warns.some((m) => /token/i.test(m))).toBe(true);
  });

  it('aborts cleanly when the user declines the prompt', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runAddLanguage({
      ...baseOpts,
      yes: false,
      confirm: async () => false,
      name: 'demo',
      language: 'python',
      monocerosHome: home,
    });
    expect(result.status).toBe('aborted');
    const yml = await ymlOf('demo');
    expect(yml).not.toContain('python');
  });

  it('errors when the named config does not exist', async () => {
    await expect(
      runAddLanguage({
        ...baseOpts,
        name: 'nope',
        language: 'python',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/No such config.*nope\.yml/);
  });

  it('rejects an invalid container name without touching disk', async () => {
    await expect(
      runAddLanguage({
        ...baseOpts,
        name: 'has space',
        language: 'python',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Invalid container name/);
  });

  // ─── remove-* ─────────────────────────────────────────────────────

  it('runRemoveLanguage removes the entry and drops the empty array', async () => {
    await writeYml(
      'demo',
      [
        '# my notes',
        'schemaVersion: 1',
        'name: demo',
        'languages:',
        '  - python',
        '',
      ].join('\n'),
    );
    const result = await runRemoveLanguage({
      ...baseOpts,
      name: 'demo',
      language: 'python',
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('# my notes');
    expect(yml).not.toContain('python');
    expect(yml).not.toContain('languages:');
  });

  it('runRemoveService removes one service while leaving others intact', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: postgres',
        '    image: postgres:18',
        '  - name: redis',
        '    image: redis:8',
        '',
      ].join('\n'),
    );
    await runRemoveService({
      ...baseOpts,
      name: 'demo',
      service: 'postgres',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('name: redis');
    expect(yml).not.toContain('postgres');
  });

  it('runRemoveLanguage is a no-op when the entry is missing', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runRemoveLanguage({
      ...baseOpts,
      name: 'demo',
      language: 'python',
      monocerosHome: home,
    });
    expect(result.status).toBe('no-change');
  });

  it('runRemoveAptPackages strips multiple, preserving comments on survivors', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'aptPackages:',
        '  - make',
        '  - jq # JSON in shell',
        '  - curl',
        '',
      ].join('\n'),
    );
    await runRemoveAptPackages({
      ...baseOpts,
      name: 'demo',
      packages: ['make', 'curl'],
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('- jq # JSON in shell');
    expect(yml).not.toContain('- make');
    expect(yml).not.toContain('- curl');
  });

  it('runRemoveFeature drops a feature entry by ref', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'features:',
        '  - ref: ghcr.io/devcontainers/features/docker-in-docker:2',
        '    options:',
        '      version: latest',
        '',
      ].join('\n'),
    );
    await runRemoveFeature({
      ...baseOpts,
      name: 'demo',
      ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).not.toContain('docker-in-docker');
    expect(yml).not.toContain('features:');
  });

  it('runRemoveFromUrl drops an install URL', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'installUrls:',
        '  - https://example.com/a',
        '  - https://example.com/b',
        '',
      ].join('\n'),
    );
    await runRemoveFromUrl({
      ...baseOpts,
      name: 'demo',
      url: 'https://example.com/a',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('- https://example.com/b');
    expect(yml).not.toContain('- https://example.com/a');
  });

  it('runRemoveRepo matches by url', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'repos:',
        '  - url: https://github.com/foo/bar.git',
        '  - url: https://github.com/foo/baz.git',
        '',
      ].join('\n'),
    );
    await runRemoveRepo({
      ...baseOpts,
      name: 'demo',
      target: 'https://github.com/foo/bar.git',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('baz.git');
    expect(yml).not.toContain('bar.git');
  });

  it('runRemoveRepo matches by derived (URL-default) name', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'repos:',
        '  - url: https://github.com/foo/bar.git',
        '',
      ].join('\n'),
    );
    await runRemoveRepo({
      ...baseOpts,
      name: 'demo',
      target: 'bar',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).not.toContain('repos:');
  });

  it('runRemoveRepo matches by explicit name', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'repos:',
        '  - url: https://github.com/foo/bar.git',
        '    path: ui',
        '',
      ].join('\n'),
    );
    await runRemoveRepo({
      ...portOpts,
      name: 'demo',
      target: 'ui',
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).not.toContain('repos:');
  });

  // ─── ports ──────────────────────────────────────────────────────

  it('runAddPort appends ports in short form and validates round-trip', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runAddPort({
      ...portOpts,
      name: 'demo',
      ports: [3000, 5173, 6006],
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('routing:');
    expect(yml).toMatch(/routing:\s*\n\s+ports:/);
    expect(yml).toContain('- 3000');
    expect(yml).toContain('- 5173');
    expect(yml).toContain('- 6006');
    // Hot-reload side effect: Traefik dynamic config file is now there
    const dyn = await fs.readFile(
      path.join(home, 'traefik', 'dynamic', 'demo.yml'),
      'utf8',
    );
    expect(dyn).toContain('http://demo:3000');
    expect(dyn).toContain('http://demo:5173');
    expect(dyn).toContain('http://demo:6006');
  });

  it('runAddPort refreshes the briefing (AGENTS.md) for a materialized container', async () => {
    await writeYml('webapp', 'schemaVersion: 1\nname: webapp\n');
    // Materialize the container dir so the live hot-reload path also rewrites
    // the briefing (it skips when the container was never applied).
    await mkdir(path.join(home, 'container', 'webapp'), { recursive: true });

    const result = await runAddPort({
      ...portOpts,
      name: 'webapp',
      ports: [5173],
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');

    const agents = await fs.readFile(
      path.join(home, 'container', 'webapp', 'AGENTS.md'),
      'utf8',
    );
    expect(agents).toContain('5173');
  });

  it('runAddPort does not write a briefing when the container is not materialized', async () => {
    await writeYml('nomat', 'schemaVersion: 1\nname: nomat\n');
    const result = await runAddPort({
      ...portOpts,
      name: 'nomat',
      ports: [5173],
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    // No container/<name>/ dir existed, so nothing was created there.
    expect(existsSync(path.join(home, 'container', 'nomat'))).toBe(false);
  });

  it('runAddPort is a no-op when every port is already present', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '',
      ].join('\n'),
    );
    const result = await runAddPort({
      ...portOpts,
      name: 'demo',
      ports: [3000],
      monocerosHome: home,
    });
    expect(result.status).toBe('no-change');
  });

  it('runAddPort only appends the missing ports — comments survive', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000 # vite',
        '    - 5173 # api',
        '',
      ].join('\n'),
    );
    const result = await runAddPort({
      ...portOpts,
      name: 'demo',
      ports: [3000, 6006],
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    expect(yml).toContain('# vite');
    expect(yml).toContain('# api');
    expect(yml.match(/- 3000\b/g)).toHaveLength(1);
    expect(yml).toContain('- 6006');
  });

  it('runAddPort matches the long form when checking for duplicates', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - port: 9229',
        '',
      ].join('\n'),
    );
    const result = await runAddPort({
      ...portOpts,
      name: 'demo',
      ports: [9229],
      monocerosHome: home,
    });
    expect(result.status).toBe('no-change');
  });

  it('runAddPort rejects out-of-range values verbatim', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddPort({
        ...portOpts,
        name: 'demo',
        ports: [70000],
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Invalid port: 70000/);
    await expect(
      runAddPort({
        ...portOpts,
        name: 'demo',
        ports: [0],
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Invalid port: 0/);
  });

  it('runAddPort --default moves an existing port to position 0', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '    - 5173',
        '    - 6006',
        '',
      ].join('\n'),
    );
    const result = await runAddPort({
      ...portOpts,
      name: 'demo',
      ports: [5173],
      asDefault: true,
      monocerosHome: home,
    });
    expect(result.status).toBe('updated');
    const yml = await ymlOf('demo');
    // 5173 now first, then 3000, then 6006 — original order preserved
    // among the non-promoted entries.
    const portLines = yml
      .split('\n')
      .filter((l) => /^\s+- \d+/.test(l))
      .map((l) => l.trim());
    expect(portLines).toEqual(['- 5173', '- 3000', '- 6006']);
  });

  it('runAddPort --default inserts the port at position 0 when not present', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '',
      ].join('\n'),
    );
    await runAddPort({
      ...portOpts,
      name: 'demo',
      ports: [9229],
      asDefault: true,
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    const portLines = yml
      .split('\n')
      .filter((l) => /^\s+- \d+/.test(l))
      .map((l) => l.trim());
    expect(portLines).toEqual(['- 9229', '- 3000']);
  });

  it('runAddPort --default is a no-op when the port is already at position 0', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '    - 5173',
        '',
      ].join('\n'),
    );
    const result = await runAddPort({
      ...portOpts,
      name: 'demo',
      ports: [3000],
      asDefault: true,
      monocerosHome: home,
    });
    expect(result.status).toBe('no-change');
  });

  it('runAddPort --default rejects more than one port', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await expect(
      runAddPort({
        ...portOpts,
        name: 'demo',
        ports: [3000, 5173],
        asDefault: true,
        monocerosHome: home,
      }),
    ).rejects.toThrow(/--default takes exactly one port/);
  });

  it('runRemovePort drops a port, prunes the empty routing block, and removes the dynamic config', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '',
      ].join('\n'),
    );
    // Seed a stale dynamic-config file so we can prove removal sweeps it.
    await mkdir(path.join(home, 'traefik', 'dynamic'), { recursive: true });
    await writeFile(
      path.join(home, 'traefik', 'dynamic', 'demo.yml'),
      'stale\n',
    );
    await runRemovePort({
      ...portOpts,
      name: 'demo',
      ports: [3000],
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    // The whole routing block is gone — no vscodeAutoForward set, so
    // an empty `routing:` is meaningless and gets pruned.
    expect(yml).not.toContain('routing:');
    expect(yml).not.toContain('3000');
    expect(existsSync(path.join(home, 'traefik', 'dynamic', 'demo.yml'))).toBe(
      false,
    );
  });

  it('runRemovePort matches the long form too', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '    - port: 9229',
        '',
      ].join('\n'),
    );
    await runRemovePort({
      ...portOpts,
      name: 'demo',
      ports: [9229],
      monocerosHome: home,
    });
    const yml = await ymlOf('demo');
    expect(yml).toContain('- 3000');
    expect(yml).not.toMatch(/9229/);
  });

  it('runRemovePort is a no-op when the port is not present', async () => {
    await writeYml(
      'demo',
      [
        'schemaVersion: 1',
        'name: demo',
        'routing:',
        '  ports:',
        '    - 3000',
        '',
      ].join('\n'),
    );
    const result = await runRemovePort({
      ...portOpts,
      name: 'demo',
      ports: [9999],
      monocerosHome: home,
    });
    expect(result.status).toBe('no-change');
  });
});
