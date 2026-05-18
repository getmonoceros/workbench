import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runApply } from '../src/apply/index.js';
import { readStateFile } from '../src/config/state.js';

const silentLogger = {
  info: () => {},
  success: () => {},
  warn: () => {},
};

const stubDevcontainerSpawn = async () => 0;
const stubCleanupSpawn = async () => 0;
const stubIdentitySpawn = async () => ({ value: '', exitCode: 1 });
const stubIdentityPrompt = async () => undefined;
const stubCredentialsSpawn = async () => ({ stdout: '', exitCode: 1 });

const baseRunOpts = {
  cliVersion: '0.0.0',
  logger: silentLogger,
  devcontainerSpawn: stubDevcontainerSpawn,
  cleanupSpawn: stubCleanupSpawn,
  identitySpawn: stubIdentitySpawn,
  identityPrompt: stubIdentityPrompt,
  credentialsSpawn: stubCredentialsSpawn,
};

describe('runApply', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-apply-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function writeYml(name: string, body: string): Promise<void> {
    await writeFile(path.join(home, 'container-configs', `${name}.yml`), body);
  }

  it('materializes into <home>/container/<name>/ by convention', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const result = await runApply({
      ...baseRunOpts,
      name: 'demo',
      monocerosHome: home,
    });

    const expected = path.join(home, 'container', 'demo');
    expect(result.targetDir).toBe(expected);
    expect(result.containerExitCode).toBe(0);

    const devcontainer = JSON.parse(
      await readFile(
        path.join(expected, '.devcontainer', 'devcontainer.json'),
        'utf8',
      ),
    );
    expect(devcontainer.name).toBe('demo');
    expect(devcontainer.image).toBe('monoceros-runtime:dev');

    const state = await readStateFile(expected);
    expect(state?.origin).toBe('demo');
    expect(state?.schemaVersion).toBe(1);
  });

  it('redirects ghcr.io/monoceros/features/<name>:<tag> to the local workbench copy when present', async () => {
    await writeYml(
      'with-feature',
      [
        'schemaVersion: 1',
        'name: with-feature',
        'features:',
        '  - ref: ghcr.io/monoceros/features/claude-code:1',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'with-feature',
      monocerosHome: home,
    });
    const devcontainerDir = path.join(
      home,
      'container',
      'with-feature',
      '.devcontainer',
    );
    const devcontainer = JSON.parse(
      await readFile(path.join(devcontainerDir, 'devcontainer.json'), 'utf8'),
    );
    // During dev the workbench has the feature on disk → the ref is
    // rewritten to a relative path inside .devcontainer/, and the
    // feature directory is copied into the container scaffold so
    // devcontainer-cli builds from the local source. (Absolute paths
    // to local features are rejected by devcontainer-cli.)
    expect(devcontainer.features).toEqual({
      './features/claude-code': {},
    });
    const copiedManifest = JSON.parse(
      await readFile(
        path.join(
          devcontainerDir,
          'features',
          'claude-code',
          'devcontainer-feature.json',
        ),
        'utf8',
      ),
    );
    expect(copiedManifest.id).toBe('claude-code');
  });

  it('creates home/ and .gitignore at the container root on every apply', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });
    const containerRoot = path.join(home, 'container', 'demo');
    const homeStat = await readFile(
      path.join(containerRoot, '.gitignore'),
      'utf8',
    );
    expect(homeStat).toContain('/home/');
    expect(homeStat).toContain('/.monoceros/');
    // home/ exists as a directory even when no feature requests a
    // persistent path — the convention is stable regardless of yml.
    await expect(
      readFile(path.join(containerRoot, 'home', '.placeholder'), 'utf8').catch(
        () => null,
      ),
    ).resolves.toBeNull();
  });

  it('generates per-feature persistent-home mounts in image-mode devcontainer.json', async () => {
    await writeYml(
      'with-claude',
      [
        'schemaVersion: 1',
        'name: with-claude',
        'features:',
        '  - ref: ghcr.io/monoceros/features/claude-code:1',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'with-claude',
      monocerosHome: home,
    });
    const containerRoot = path.join(home, 'container', 'with-claude');
    const devcontainer = JSON.parse(
      await readFile(
        path.join(containerRoot, '.devcontainer', 'devcontainer.json'),
        'utf8',
      ),
    );
    expect(devcontainer.mounts).toContain(
      'source=${localWorkspaceFolder}/home/.claude,target=/home/node/.claude,type=bind',
    );
    // Pre-created on the host so docker doesn't auto-mkdir as root.
    const claudeDir = path.join(containerRoot, 'home', '.claude');
    await expect(
      readFile(path.join(claudeDir, '.does-not-need-to-exist')).catch(
        () => null,
      ),
    ).resolves.toBeNull();
    // The dir itself should exist — readdir succeeds.
    await expect(
      (await import('node:fs/promises')).readdir(claudeDir),
    ).resolves.toEqual([]);
  });

  it('seeds the persistent .claude.json with valid JSON on first apply', async () => {
    await writeYml(
      'fresh',
      [
        'schemaVersion: 1',
        'name: fresh',
        'features:',
        '  - ref: ghcr.io/monoceros/features/claude-code:1',
        '',
      ].join('\n'),
    );
    await runApply({ ...baseRunOpts, name: 'fresh', monocerosHome: home });
    const claudeJsonPath = path.join(
      home,
      'container',
      'fresh',
      'home',
      '.claude.json',
    );
    const content = await readFile(claudeJsonPath, 'utf8');
    // Valid JSON — Claude Code refuses to start when this file is
    // 0-byte / unparseable, so seeding it with `{}` is critical.
    expect(() => JSON.parse(content)).not.toThrow();
    expect(content.trim()).toBe('{}');
  });

  it('preserves home/<subpath> content across re-apply', async () => {
    await writeYml(
      'persists',
      [
        'schemaVersion: 1',
        'name: persists',
        'features:',
        '  - ref: ghcr.io/monoceros/features/claude-code:1',
        '',
      ].join('\n'),
    );
    await runApply({ ...baseRunOpts, name: 'persists', monocerosHome: home });
    const credentialsPath = path.join(
      home,
      'container',
      'persists',
      'home',
      '.claude',
      '.credentials.json',
    );
    await writeFile(credentialsPath, '{"fake":"token"}');
    // Re-apply should leave the on-disk login alone.
    await runApply({ ...baseRunOpts, name: 'persists', monocerosHome: home });
    const after = await readFile(credentialsPath, 'utf8');
    expect(after).toBe('{"fake":"token"}');
  });

  it('emits the post-create hook-runner block', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });
    const postCreate = await readFile(
      path.join(home, 'container', 'demo', '.devcontainer', 'post-create.sh'),
      'utf8',
    );
    expect(postCreate).toContain('/usr/local/share/monoceros/post-create.d');
    expect(postCreate).toMatch(/for hook in .*post-create\.d\/\*\.sh/);
  });

  it('merges defaults.features from monoceros-config.yml into per-container options', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      [
        'schemaVersion: 1',
        'defaults:',
        '  features:',
        '    ghcr.io/monoceros/features/claude-code:1:',
        '      apiKey: sk-ant-from-defaults',
        '',
      ].join('\n'),
    );
    await writeYml(
      'merged',
      [
        'schemaVersion: 1',
        'name: merged',
        'features:',
        '  - ref: ghcr.io/monoceros/features/claude-code:1',
        '    options:',
        '      version: "0.5.1"',
        '',
      ].join('\n'),
    );
    await runApply({ ...baseRunOpts, name: 'merged', monocerosHome: home });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'merged',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    // apiKey came from defaults, version was overridden per-container.
    expect(devcontainer.features['./features/claude-code']).toEqual({
      apiKey: 'sk-ant-from-defaults',
      version: '0.5.1',
    });
  });

  it('per-container options win over defaults.features for the same key', async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      [
        'schemaVersion: 1',
        'defaults:',
        '  features:',
        '    ghcr.io/monoceros/features/claude-code:1:',
        '      apiKey: sk-ant-default',
        '',
      ].join('\n'),
    );
    await writeYml(
      'override',
      [
        'schemaVersion: 1',
        'name: override',
        'features:',
        '  - ref: ghcr.io/monoceros/features/claude-code:1',
        '    options:',
        '      apiKey: sk-ant-per-container',
        '',
      ].join('\n'),
    );
    await runApply({ ...baseRunOpts, name: 'override', monocerosHome: home });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'override',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    expect(devcontainer.features['./features/claude-code']).toEqual({
      apiKey: 'sk-ant-per-container',
    });
  });

  it("does not include a defaults-only feature that's not in the container yml", async () => {
    await writeFile(
      path.join(home, 'monoceros-config.yml'),
      [
        'schemaVersion: 1',
        'defaults:',
        '  features:',
        '    ghcr.io/monoceros/features/claude-code:1:',
        '      apiKey: sk-ant-default',
        '',
      ].join('\n'),
    );
    // No features: at all in the container yml.
    await writeYml('bare', 'schemaVersion: 1\nname: bare\n');
    await runApply({ ...baseRunOpts, name: 'bare', monocerosHome: home });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'bare',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    expect(devcontainer.features).toBeUndefined();
  });

  it('passes through Monoceros feature refs verbatim when the local copy is absent', async () => {
    // Unknown feature name → no local file → ref passes through so
    // devcontainer-cli would pull from GHCR. (Behaves like prod, where
    // the workbench checkout isn't present.)
    await writeYml(
      'unknown-feature',
      [
        'schemaVersion: 1',
        'name: unknown-feature',
        'features:',
        '  - ref: ghcr.io/monoceros/features/not-built-yet:1',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'unknown-feature',
      monocerosHome: home,
    });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'unknown-feature',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    expect(devcontainer.features).toEqual({
      'ghcr.io/monoceros/features/not-built-yet:1': {},
    });
  });

  it('passes through third-party OCI feature refs verbatim', async () => {
    await writeYml(
      'oci-feature',
      [
        'schemaVersion: 1',
        'name: oci-feature',
        'features:',
        '  - ref: ghcr.io/devcontainers/features/github-cli:1',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'oci-feature',
      monocerosHome: home,
    });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'oci-feature',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    expect(devcontainer.features).toEqual({
      'ghcr.io/devcontainers/features/github-cli:1': {},
    });
  });

  it('materializes a compose-mode scaffold when services are configured', async () => {
    await writeYml(
      'pgdemo',
      [
        'schemaVersion: 1',
        'name: pgdemo',
        'services:',
        '  - postgres',
        '',
      ].join('\n'),
    );
    await runApply({ ...baseRunOpts, name: 'pgdemo', monocerosHome: home });

    const composeText = await readFile(
      path.join(home, 'container', 'pgdemo', '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    expect(composeText).toContain('postgres:');
  });

  it('binds service data to <container-dir>/data/<svc>/ instead of named volumes', async () => {
    await writeYml(
      'dbhost',
      [
        'schemaVersion: 1',
        'name: dbhost',
        'services:',
        '  - postgres',
        '  - redis',
        '',
      ].join('\n'),
    );
    await runApply({ ...baseRunOpts, name: 'dbhost', monocerosHome: home });

    const composeText = await readFile(
      path.join(home, 'container', 'dbhost', '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    // Bind-mount each service onto a sibling `data/<svc>` directory
    // (paths in compose.yaml are relative to .devcontainer/).
    expect(composeText).toContain(
      '      - ../data/postgres:/var/lib/postgresql',
    );
    expect(composeText).toContain('      - ../data/redis:/data');
    // The named-volumes top-level section must be gone — that was
    // the old layout.
    expect(composeText).not.toMatch(/^volumes:/m);

    // Host-side dirs are pre-created so docker doesn't auto-mkdir
    // them as root.
    const containerRoot = path.join(home, 'container', 'dbhost');
    const fsp = await import('node:fs/promises');
    await expect(
      fsp.readdir(path.join(containerRoot, 'data', 'postgres')),
    ).resolves.toEqual([]);
    await expect(
      fsp.readdir(path.join(containerRoot, 'data', 'redis')),
    ).resolves.toEqual([]);

    // `.gitignore` excludes data/ so DB content doesn't sneak into
    // a wrapping git repo.
    const gitignore = await readFile(
      path.join(containerRoot, '.gitignore'),
      'utf8',
    );
    expect(gitignore).toContain('/data/');
  });

  it('does not create data/ when no services are configured', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });
    const dataDir = path.join(home, 'container', 'demo', 'data');
    const fsp = await import('node:fs/promises');
    await expect(fsp.access(dataDir)).rejects.toThrow();
  });

  it('records cliVersion and timestamp in state.json', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApply({
      ...baseRunOpts,
      name: 'demo',
      monocerosHome: home,
      cliVersion: '1.2.3',
      now: new Date('2026-05-16T10:00:00Z'),
    });
    const state = await readStateFile(path.join(home, 'container', 'demo'));
    expect(state).toEqual({
      schemaVersion: 1,
      origin: 'demo',
      monocerosCliVersion: '1.2.3',
      materializedAt: '2026-05-16T10:00:00.000Z',
    });
  });

  it('overwrites scaffold files when re-applying the same origin', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });

    await writeYml(
      'demo',
      ['schemaVersion: 1', 'name: demo', 'services:', '  - redis', ''].join(
        '\n',
      ),
    );
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });

    const composeText = await readFile(
      path.join(home, 'container', 'demo', '.devcontainer', 'compose.yaml'),
      'utf8',
    );
    expect(composeText).toContain('redis:');
  });

  it('removes a stale compose.yaml when services are dropped on re-apply', async () => {
    await writeYml(
      'demo',
      ['schemaVersion: 1', 'name: demo', 'services:', '  - postgres', ''].join(
        '\n',
      ),
    );
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    await runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home });
    await expect(
      readFile(
        path.join(home, 'container', 'demo', '.devcontainer', 'compose.yaml'),
      ),
    ).rejects.toThrow();
  });

  it('errors when the config does not exist', async () => {
    await expect(
      runApply({ ...baseRunOpts, name: 'missing', monocerosHome: home }),
    ).rejects.toThrow(/No such config.*missing\.yml/);
  });

  it('errors when the yml fails schema validation', async () => {
    await writeYml('demo', 'schemaVersion: 99\nname: demo\n');
    await expect(
      runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home }),
    ).rejects.toThrow(/schemaVersion/);
  });

  it('errors when an unknown language slips past shape validation', async () => {
    await writeYml(
      'demo',
      ['schemaVersion: 1', 'name: demo', 'languages:', '  - klingon', ''].join(
        '\n',
      ),
    );
    await expect(
      runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home }),
    ).rejects.toThrow(/Unknown language: klingon/);
  });

  it('refuses to materialize into a non-empty unrelated directory', async () => {
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const targetDir = path.join(home, 'container', 'demo');
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, 'random.txt'), 'hi');
    await expect(
      runApply({ ...baseRunOpts, name: 'demo', monocerosHome: home }),
    ).rejects.toThrow(/Refusing to materialize/);
  });

  it('rejects an invalid config name without touching disk', async () => {
    await expect(
      runApply({ ...baseRunOpts, name: 'has space', monocerosHome: home }),
    ).rejects.toThrow(/Invalid config name/);
  });
});
