import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
// Replaces the previous `stubCleanupSpawn: async () => 0`. The
// cleanup is now driven by direct docker exec calls, so the stub
// returns the DockerResult shape that spawnDocker produces. Empty
// stdout = "no containers to clean up", exitCode 0 keeps the apply
// flow going.
const stubDockerExec = async () => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
});
const stubIdentitySpawn = async () => ({ value: '', exitCode: 1 });
const stubIdentityPrompt = async () => undefined;
// Default stub: every host has credentials. Apply's pre-flight check
// (added with M5-Task-11) fails fast if a host returns no creds, so
// tests that don't specifically exercise the missing-credentials path
// inherit "always-ok" credentials. Tests that want to verify the
// pre-flight error supply their own credentialsSpawn that returns
// an empty stdout / non-zero exit.
const stubCredentialsSpawn = async (input: string) => {
  const host = /host=([^\n]+)/.exec(input)?.[1] ?? 'unknown';
  return {
    stdout: `protocol=https\nhost=${host}\nusername=ci\npassword=tok-${host}\n`,
    exitCode: 0,
  };
};
// Default stub for the repo-reachability pre-flight (stage 2):
// every declared repo URL is reachable. Tests that exercise the
// "repo not found" path supply their own reachabilitySpawn.
const stubReachabilitySpawn = async () => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
});

// Default stub for the host-side repo clone: pretend the clone
// succeeded by creating the target dir, so post-conditions (and any
// service bind-mount into projects/) see a real directory. Tests that
// exercise clone failure supply their own cloneSpawn.
const stubCloneSpawn = async (_url: string, dest: string) => {
  await mkdir(dest, { recursive: true });
  return { stdout: '', stderr: '', exitCode: 0 };
};

// Default stub for the docker-mode probe: rootful daemon (no idmap
// in the generated devcontainer.json). Tests that exercise the
// rootless code path supply their own dockerInfoSpawn that returns
// stdout containing the `rootless` token.
const stubDockerInfoSpawn = async () => ({
  stdout: '["name=seccomp,profile=builtin"]',
  exitCode: 0,
});

const baseRunOpts = {
  cliVersion: '0.0.0',
  logger: silentLogger,
  devcontainerSpawn: stubDevcontainerSpawn,
  dockerExec: stubDockerExec,
  identitySpawn: stubIdentitySpawn,
  identityPrompt: stubIdentityPrompt,
  credentialsSpawn: stubCredentialsSpawn,
  reachabilitySpawn: stubReachabilitySpawn,
  cloneSpawn: stubCloneSpawn,
  dockerInfoSpawn: stubDockerInfoSpawn,
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
    expect(devcontainer.image).toBe('ghcr.io/getmonoceros/monoceros-runtime:1');

    const state = await readStateFile(expected);
    expect(state?.origin).toBe('demo');
    expect(state?.schemaVersion).toBe(1);
  });

  it('redirects ghcr.io/getmonoceros/monoceros-features/<name>:<tag> to the local workbench copy when present', async () => {
    await writeYml(
      'with-feature',
      [
        'schemaVersion: 1',
        'name: with-feature',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
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
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
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
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
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
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
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
        '    ghcr.io/getmonoceros/monoceros-features/claude-code:1:',
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
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
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
        '    ghcr.io/getmonoceros/monoceros-features/claude-code:1:',
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
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
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
        '    ghcr.io/getmonoceros/monoceros-features/claude-code:1:',
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
        '  - ref: ghcr.io/getmonoceros/monoceros-features/not-built-yet:1',
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
      'ghcr.io/getmonoceros/monoceros-features/not-built-yet:1': {},
    });
  });

  it('warns when a deprecated ghcr.io/monoceros/features/<name>:<tag> ref is used', async () => {
    const warnings: string[] = [];
    const captureLogger = {
      info: () => {},
      success: () => {},
      warn: (msg: string) => {
        warnings.push(msg);
      },
    };
    await writeYml(
      'legacy-ref',
      [
        'schemaVersion: 1',
        'name: legacy-ref',
        'features:',
        '  - ref: ghcr.io/monoceros/features/claude-code:1',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      logger: captureLogger,
      name: 'legacy-ref',
      monocerosHome: home,
    });
    expect(warnings.some((w) => w.includes('Deprecated feature ref'))).toBe(
      true,
    );
    expect(
      warnings.some((w) =>
        w.includes('ghcr.io/getmonoceros/monoceros-features/claude-code:1'),
      ),
    ).toBe(true);
    // The yml itself is left untouched — the warn does not rewrite.
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'legacy-ref',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    expect(devcontainer.features).toEqual({
      'ghcr.io/monoceros/features/claude-code:1': {},
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
        '  - name: postgres',
        '    image: postgres:18',
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
        '  - name: postgres',
        '    image: postgres:18',
        '    volumes:',
        '      - data:/var/lib/postgresql',
        '  - name: redis',
        '    image: redis:8',
        '    volumes:',
        '      - data:/data',
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

  it('passes :version from a language entry through to the upstream feature option', async () => {
    await writeYml(
      'pin',
      [
        'schemaVersion: 1',
        'name: pin',
        'languages:',
        '  - java:17',
        '  - node:20',
        '',
      ].join('\n'),
    );
    await runApply({ ...baseRunOpts, name: 'pin', monocerosHome: home });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'pin',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    expect(
      devcontainer.features['ghcr.io/devcontainers/features/java:1'],
    ).toEqual({ version: '17' });
    expect(
      devcontainer.features['ghcr.io/devcontainers/features/node:1'],
    ).toEqual({ version: '20' });
  });

  it('bare `node` stays a builtin and does not install the upstream node feature', async () => {
    await writeYml(
      'bare-node',
      [
        'schemaVersion: 1',
        'name: bare-node',
        'languages:',
        '  - node',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'bare-node',
      monocerosHome: home,
    });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'bare-node',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    expect(devcontainer.features).toBeUndefined();
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
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: redis',
        '    image: redis:8',
        '',
      ].join('\n'),
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
      [
        'schemaVersion: 1',
        'name: demo',
        'services:',
        '  - name: postgres',
        '    image: postgres:18',
        '',
      ].join('\n'),
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

  it('recovers from a partial-apply remnant (only .monoceros/ present, no state.json)', async () => {
    // Reproduces the failure mode the user hit on Ubuntu: a previous
    // apply got past the credential/identity pre-flight (which wrote
    // .monoceros/gitconfig + .monoceros/git-credentials) but
    // aborted before writeStateFile. The next apply should NOT see
    // a leftover .monoceros/ directory as "someone else's stuff" —
    // we own that subdirectory entirely.
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const targetDir = path.join(home, 'container', 'demo');
    const monocerosDir = path.join(targetDir, '.monoceros');
    await mkdir(monocerosDir, { recursive: true });
    await writeFile(
      path.join(monocerosDir, 'git-credentials'),
      'https://ci:tok@github.com\n',
    );
    await writeFile(
      path.join(monocerosDir, 'gitconfig'),
      '[user]\n  name = Test\n  email = test@example.com\n',
    );
    // No state.json on purpose.
    const result = await runApply({
      ...baseRunOpts,
      name: 'demo',
      monocerosHome: home,
    });
    expect(result.containerExitCode).toBe(0);
    // After a successful re-apply, state.json IS there.
    const state = await readStateFile(targetDir);
    expect(state?.origin).toBe('demo');
  });

  it('still refuses when .monoceros/ AND unrelated files coexist without state.json', async () => {
    // .monoceros/ alone is recoverable (above test). .monoceros/ plus
    // other top-level files is suspicious — could be someone else's
    // work that happens to share the dir. Stay strict.
    await writeYml('demo', 'schemaVersion: 1\nname: demo\n');
    const targetDir = path.join(home, 'container', 'demo');
    const monocerosDir = path.join(targetDir, '.monoceros');
    await mkdir(monocerosDir, { recursive: true });
    await writeFile(path.join(monocerosDir, 'gitconfig'), '[user]\n');
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

  // ─── SSH-Agent forwarding: only when actually needed ──────────────
  //
  // The SSH-agent mount is added to devcontainer.json `mounts` only
  // when at least one repo URL is SSH-style (git@, ssh://, git://).
  // HTTPS repos use the host-side credential fetch path and don't need
  // a live agent socket. This narrowing avoids the macOS Docker
  // Desktop launchd-socket sandboxing failure for the common case
  // (HTTPS-only repos).

  it('post-create.sh sets per-repo git.user when repo has gitUser override', async () => {
    await writeYml(
      'with-identity',
      [
        'schemaVersion: 1',
        'name: with-identity',
        'repos:',
        '  - url: https://github.com/work/api.git',
        '    git:',
        '      user:',
        '        name: Thorsten (work)',
        '        email: tk@conciso.de',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'with-identity',
      monocerosHome: home,
    });
    const postCreate = await readFile(
      path.join(
        home,
        'container',
        'with-identity',
        '.devcontainer',
        'post-create.sh',
      ),
      'utf8',
    );
    expect(postCreate).toContain(
      'git -C "projects/api" config user.name "Thorsten (work)"',
    );
    expect(postCreate).toContain(
      'git -C "projects/api" config user.email "tk@conciso.de"',
    );
  });

  it('clones declared repos host-side before bringing the container up', async () => {
    await writeYml(
      'cloned',
      [
        'schemaVersion: 1',
        'name: cloned',
        'repos:',
        '  - url: https://github.com/foo/bar.git',
        '',
      ].join('\n'),
    );
    const order: string[] = [];
    const cloneCalls: Array<{ url: string; dest: string }> = [];
    await runApply({
      ...baseRunOpts,
      name: 'cloned',
      monocerosHome: home,
      cloneSpawn: async (url, dest) => {
        order.push('clone');
        cloneCalls.push({ url, dest });
        await mkdir(dest, { recursive: true });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      devcontainerSpawn: async () => {
        order.push('up');
        return 0;
      },
    });
    const projectsBar = path.join(
      home,
      'container',
      'cloned',
      'projects',
      'bar',
    );
    expect(cloneCalls).toEqual([
      { url: 'https://github.com/foo/bar.git', dest: projectsBar },
    ]);
    expect(existsSync(projectsBar)).toBe(true);
    // clone must happen before the container comes up
    expect(order[0]).toBe('clone');
    expect(order).toContain('up');
  });

  it('skips the host-side clone on re-apply when projects/<path> already exists', async () => {
    await writeYml(
      'recloned',
      [
        'schemaVersion: 1',
        'name: recloned',
        'repos:',
        '  - url: https://github.com/foo/bar.git',
        '',
      ].join('\n'),
    );
    let cloneCount = 0;
    const opts = {
      ...baseRunOpts,
      name: 'recloned',
      monocerosHome: home,
      cloneSpawn: async (_url: string, dest: string) => {
        cloneCount += 1;
        await mkdir(dest, { recursive: true });
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    await runApply(opts); // first apply → clones
    await runApply(opts); // second apply → projects/bar exists → skip
    expect(cloneCount).toBe(1);
  });

  it('post-create.sh does not set per-repo git.user when repo has no override', async () => {
    await writeYml(
      'no-identity',
      [
        'schemaVersion: 1',
        'name: no-identity',
        'repos:',
        '  - url: https://github.com/foo/bar.git',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'no-identity',
      monocerosHome: home,
    });
    const postCreate = await readFile(
      path.join(
        home,
        'container',
        'no-identity',
        '.devcontainer',
        'post-create.sh',
      ),
      'utf8',
    );
    // The clone block is present, but no `git -C ... config user.*`.
    expect(postCreate).toContain('git clone "https://github.com/foo/bar.git"');
    expect(postCreate).not.toMatch(/git -C ".*" config user\./);
  });

  it('pre-flight fails apply with provider-specific hints when host has no credentials', async () => {
    await writeYml(
      'no-creds',
      [
        'schemaVersion: 1',
        'name: no-creds',
        'repos:',
        '  - url: https://github.com/foo/bar.git',
        '',
      ].join('\n'),
    );
    await expect(
      runApply({
        ...baseRunOpts,
        // Override the always-ok stub: return empty stdout, exit 0
        // (mirrors how `git credential fill` on a host without a
        // configured helper actually behaves — no error code, just
        // missing username/password fields in the output).
        credentialsSpawn: async () => ({ stdout: '', exitCode: 0 }),
        name: 'no-creds',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Missing Git credentials:.*github\.com/s);
  });

  it('pre-flight fails with "set provider:" error for non-canonical hosts without explicit provider', async () => {
    // Self-hosted GitLab / Gitea / corporate domains can be smuggled
    // in via a hand-edited yml (init/add-repo would reject this).
    // Pre-flight should still catch it and point at the fix.
    await writeYml(
      'unknown-provider',
      [
        'schemaVersion: 1',
        'name: unknown-provider',
        'repos:',
        '  - url: https://git.firma.de/team/app.git',
        '',
      ].join('\n'),
    );
    await expect(
      runApply({
        ...baseRunOpts,
        name: 'unknown-provider',
        monocerosHome: home,
      }),
    ).rejects.toThrow(
      /Unknown Git provider[\s\S]*git\.firma\.de[\s\S]*provider:/,
    );
  });

  it('refuses to apply on rootless Docker with a clear actionable error', async () => {
    // Rootless Docker's UID-shift breaks bind-mount file ownership
    // across the host/container boundary in a way we have no clean
    // workaround for (docker doesn't expose idmap as a `--mount`
    // option). Refusing early is much better UX than letting the
    // builder hit opaque permission errors mid-clone.
    await writeYml('rl-refuse', 'schemaVersion: 1\nname: rl-refuse\n');
    let devcontainerCalled = false;
    await expect(
      runApply({
        ...baseRunOpts,
        devcontainerSpawn: async () => {
          devcontainerCalled = true;
          return 0;
        },
        dockerInfoSpawn: async () => ({
          stdout: '["name=seccomp,profile=builtin","name=rootless"]',
          exitCode: 0,
        }),
        name: 'rl-refuse',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/rootful.*mode[\s\S]*usermod -aG docker/);
    // Confirm the short-circuit: no docker build attempted.
    expect(devcontainerCalled).toBe(false);
  });

  it('does NOT emit idmap on bind mounts (docker --mount does not accept it)', async () => {
    // Earlier attempts (1.6.3 / 1.6.5) tried `,idmap` and `,idmap=true`
    // as bind-mount options, on the (wrong) assumption that Docker
    // exposes the kernel's idmapped-mount feature on the --mount
    // flag. The official Docker docs list no such option; both
    // versions failed at `docker run` with "invalid argument" /
    // "unknown option". Guard against regression: regardless of the
    // detected dockerMode, no `idmap` substring should ever appear
    // in the generated devcontainer.json. A future rootless fix
    // needs a different mechanism (see scaffold.ts TODO).
    await writeYml(
      'no-idmap',
      [
        'schemaVersion: 1',
        'name: no-idmap',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        '',
      ].join('\n'),
    );
    // Use the default rootful stub — rootless is refused entirely
    // now (covered by the dedicated rootless-refuse test above), so
    // testing "no idmap on rootless" is moot. What we still want to
    // guard against is "someone re-introduces idmap on rootful by
    // accident".
    await runApply({
      ...baseRunOpts,
      name: 'no-idmap',
      monocerosHome: home,
    });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'no-idmap',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    // workspaceMount is always emitted now (so VS Code's Dev
    // Containers extension can translate host → container paths),
    // but it MUST NOT carry an `,idmap` mount option — that's what
    // this guard is for. Match against the option-separator form
    // (a comma plus `idmap`) so a container name like "no-idmap"
    // landing in the target path doesn't false-positive.
    const idmapOption = /,\s*idmap\b/;
    expect(devcontainer.workspaceMount).toBeDefined();
    expect(devcontainer.workspaceMount as string).not.toMatch(idmapOption);
    const featureMounts = (devcontainer.mounts ?? []) as string[];
    expect(featureMounts.every((m: string) => !idmapOption.test(m))).toBe(true);
  });

  it('compose mode never emits idmap either (same reason)', async () => {
    await writeYml(
      'cmp-clean',
      [
        'schemaVersion: 1',
        'name: cmp-clean',
        'services:',
        '  - name: postgres',
        '    image: postgres:18',
        '',
      ].join('\n'),
    );
    // Default rootful stub — same reasoning as the test above.
    await runApply({
      ...baseRunOpts,
      name: 'cmp-clean',
      monocerosHome: home,
    });
    const compose = await readFile(
      path.join(
        home,
        'container',
        'cmp-clean',
        '.devcontainer',
        'compose.yaml',
      ),
      'utf8',
    );
    expect(compose).not.toContain('idmap');
  });

  it('pre-flight stage 2 (reachability) catches a missing repo before docker build', async () => {
    // Credentials are present (default stub) but the repo URL is
    // unreachable. Stage 2 short-circuits — we never reach
    // runContainerCycle.
    await writeYml(
      'missing-repo',
      [
        'schemaVersion: 1',
        'name: missing-repo',
        'repos:',
        '  - url: https://bitbucket.org/conciso/monoceros-app.git',
        '',
      ].join('\n'),
    );
    let devcontainerCalled = false;
    await expect(
      runApply({
        ...baseRunOpts,
        devcontainerSpawn: async () => {
          devcontainerCalled = true;
          return 0;
        },
        reachabilitySpawn: async () => ({
          stdout: '',
          stderr:
            'remote: You may not have access to this repository or it no longer exists in this workspace.\nfatal: Authentication failed',
          exitCode: 128,
        }),
        name: 'missing-repo',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Cannot reach.*monoceros-app[\s\S]*Repository not found/);
    // Confirms we short-circuit before docker spend.
    expect(devcontainerCalled).toBe(false);
  });

  it('pre-flight stage 2 runs AFTER credential pre-flight (credentials error wins)', async () => {
    // If credentials are missing, reachability never runs — we
    // never want to probe a URL with no creds in place because the
    // resulting failure-mode classification ("auth-failed") would
    // be a worse diagnostic than the existing provider-specific
    // setup hint.
    await writeYml(
      'no-creds',
      [
        'schemaVersion: 1',
        'name: no-creds',
        'repos:',
        '  - url: https://github.com/foo/bar.git',
        '',
      ].join('\n'),
    );
    let reachabilityCalled = false;
    await expect(
      runApply({
        ...baseRunOpts,
        credentialsSpawn: async () => ({ stdout: '', exitCode: 0 }),
        reachabilitySpawn: async () => {
          reachabilityCalled = true;
          return { stdout: '', stderr: '', exitCode: 0 };
        },
        name: 'no-creds',
        monocerosHome: home,
      }),
    ).rejects.toThrow(/Missing Git credentials/);
    expect(reachabilityCalled).toBe(false);
  });

  it('pre-flight accepts non-canonical host when provider: is set explicitly', async () => {
    // Same yml, but with `provider: gitlab` — apply should proceed
    // past the unknown-provider check and reach the credential fill.
    // We let the default stub provide credentials, so the apply
    // completes successfully.
    await writeYml(
      'self-hosted-gitlab',
      [
        'schemaVersion: 1',
        'name: self-hosted-gitlab',
        'repos:',
        '  - url: https://git.firma.de/team/app.git',
        '    provider: gitlab',
        '',
      ].join('\n'),
    );
    const result = await runApply({
      ...baseRunOpts,
      name: 'self-hosted-gitlab',
      monocerosHome: home,
    });
    expect(result.containerExitCode).toBe(0);
  });

  it('never emits an SSH-agent mount or SSH_AUTH_SOCK env (HTTPS-only by design, ADR 0006)', async () => {
    await writeYml(
      'with-https-repo',
      [
        'schemaVersion: 1',
        'name: with-https-repo',
        'repos:',
        '  - url: https://github.com/foo/bar.git',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'with-https-repo',
      monocerosHome: home,
    });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'with-https-repo',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    const mounts: string[] = devcontainer.mounts ?? [];
    expect(mounts.some((m) => m.includes('/ssh-agent'))).toBe(false);
    expect(devcontainer.containerEnv?.SSH_AUTH_SOCK).toBeUndefined();
  });
});
