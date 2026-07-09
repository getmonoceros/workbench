import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
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
// Default: a provider-wide token for each provider (ADR 0031), so any
// declared repo resolves and no unauthenticated-repos warning fires.
// Tests that exercise the missing-token warning pass an empty `env`.
const stubEnv = {
  GIT_TOKEN__GITHUB: 'tok-github',
  GIT_TOKEN__GITLAB: 'tok-gitlab',
  GIT_TOKEN__BITBUCKET: 'tok-bitbucket',
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
  env: stubEnv,
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

  // apply now requires a pinned runtimeVersion (ADR 0017). Real ymls
  // get it from `init`; these test bodies predate the field, so inject
  // a pin right after `schemaVersion: 1` unless the body sets one
  // itself. Tests that exercise the unpinned-yml error path use
  // `writeFile` directly to bypass this.
  async function writeYml(name: string, body: string): Promise<void> {
    const pinned = body.includes('runtimeVersion:')
      ? body
      : body.replace(
          /^schemaVersion: 1$/m,
          'schemaVersion: 1\nruntimeVersion: 1.1.0',
        );
    await writeFile(
      path.join(home, 'container-configs', `${name}.yml`),
      pinned,
    );
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
    // The image is resolved from the pinned runtimeVersion (ADR 0017);
    // writeYml injects `runtimeVersion: 1.1.0`.
    expect(devcontainer.image).toBe(
      'ghcr.io/getmonoceros/monoceros-runtime:1.1.0',
    );

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
    // Briefing artefacts (ADR 0014) are gitignored at the container
    // root — they're Monoceros-owned, rewritten on every apply.
    expect(homeStat).toContain('/AGENTS.md');
    expect(homeStat).toContain('/CLAUDE.md');
    // home/ exists as a directory even when no feature requests a
    // persistent path — the convention is stable regardless of yml.
    await expect(
      readFile(path.join(containerRoot, 'home', '.placeholder'), 'utf8').catch(
        () => null,
      ),
    ).resolves.toBeNull();
  });

  it('writes AGENTS.md, CLAUDE.md, and .monoceros/commands.md briefing files at the container root', async () => {
    await writeYml(
      'briefed',
      'schemaVersion: 1\nname: briefed\nlanguages: [node]\n',
    );
    await runApply({ ...baseRunOpts, name: 'briefed', monocerosHome: home });
    const containerRoot = path.join(home, 'container', 'briefed');
    const agents = await readFile(
      path.join(containerRoot, 'AGENTS.md'),
      'utf8',
    );
    expect(agents).toContain('# Monoceros Container — Stack Briefing');
    expect(agents).toContain('monoceros apply briefed');
    expect(agents).toContain('<!-- monoceros:begin -->');
    expect(agents).toContain('<!-- monoceros:end -->');
    const claude = await readFile(
      path.join(containerRoot, 'CLAUDE.md'),
      'utf8',
    );
    expect(claude).toContain('@AGENTS.md');
    expect(claude).toContain('<!-- monoceros:begin -->');
    expect(claude).toContain('<!-- monoceros:end -->');
    const commands = await readFile(
      path.join(containerRoot, '.monoceros', 'commands.md'),
      'utf8',
    );
    expect(commands).toContain('# monoceros — Command reference');
  });

  it('resolves per-feature briefing lines from manifests, honouring option-gated whenOption clauses', async () => {
    // atlassian has two boolean sub-tool options (rovodev, twg) and a
    // manifest-declared `x-monoceros.briefing` with `whenOption` lines
    // for each. With twg disabled the Teamwork Graph line must NOT
    // appear; the Rovo Dev line must.
    await writeYml(
      'with-atlassian',
      [
        'schemaVersion: 1',
        'name: with-atlassian',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/atlassian:1',
        '    options:',
        '      twg: false',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'with-atlassian',
      monocerosHome: home,
    });
    const agents = await readFile(
      path.join(home, 'container', 'with-atlassian', 'AGENTS.md'),
      'utf8',
    );
    expect(agents).toContain('Atlassian Rovo Dev');
    expect(agents).not.toContain('Teamwork Graph');
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
    // The dir exists and Monoceros has written the default permission mode
    // into settings.json on apply (claude-code feature present → bypass).
    const claudeEntries = await (
      await import('node:fs/promises')
    ).readdir(claudeDir);
    expect(claudeEntries).toContain('settings.json');
    const claudeSettings = JSON.parse(
      await readFile(path.join(claudeDir, 'settings.json'), 'utf8'),
    );
    expect(claudeSettings.permissions.defaultMode).toBe('auto');
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

  it('an empty ${VAR} feature option inherits the defaults.features value', async () => {
    // The active placeholder `apiKey: ${CLAUDE_CODE_API_KEY}` with a blank
    // .env must NOT clobber the global default — it resolves to "" before
    // the merge, so the transform skips it and the default flows through.
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
      'inherit',
      [
        'schemaVersion: 1',
        'name: inherit',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        '    options:',
        '      apiKey: ${CLAUDE_CODE_API_KEY}',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(home, 'container-configs', 'inherit.env'),
      'CLAUDE_CODE_API_KEY=\n', // seeded but blank
    );
    await runApply({ ...baseRunOpts, name: 'inherit', monocerosHome: home });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'inherit',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    expect(devcontainer.features['./features/claude-code']).toEqual({
      apiKey: 'sk-ant-from-defaults',
    });
  });

  it('a filled ${VAR} feature option overrides the defaults.features value', async () => {
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
      'filled',
      [
        'schemaVersion: 1',
        'name: filled',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1',
        '    options:',
        '      apiKey: ${CLAUDE_CODE_API_KEY}',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(home, 'container-configs', 'filled.env'),
      'CLAUDE_CODE_API_KEY=sk-ant-real\n',
    );
    await runApply({ ...baseRunOpts, name: 'filled', monocerosHome: home });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'filled',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    expect(devcontainer.features['./features/claude-code']).toEqual({
      apiKey: 'sk-ant-real',
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
        // Pinned so the IDE-state named volumes are emitted — the test
        // asserts DB data is NOT among them (ADR 0015/0017 gate).
        'runtimeVersion: 1.1.0',
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
    // Service DB data stays on the bind mounts above — never a named
    // volume. The only top-level `volumes:` are the VS Code IDE-state
    // volumes (extensions + user settings, ADR 0015); the DB services
    // must not appear there.
    const volumesSection = composeText.slice(composeText.indexOf('\nvolumes:'));
    expect(volumesSection).toContain('monoceros-dbhost-vscode-extensions:');
    expect(volumesSection).toContain('monoceros-dbhost-vscode-userdata:');
    expect(volumesSection).not.toContain('postgres');
    expect(volumesSection).not.toContain('redis');

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
    ).toEqual({ installMaven: true, installGradle: true, version: '17' });
    expect(
      devcontainer.features['ghcr.io/devcontainers/features/node:1'],
    ).toEqual({ version: '20' });
  });

  it('object-form language options override the catalog defaults (editable)', async () => {
    await writeYml(
      'javaopt',
      [
        'schemaVersion: 1',
        'name: javaopt',
        'languages:',
        '  - java:',
        '      version: 17',
        '      installMaven: false',
        '',
      ].join('\n'),
    );
    await runApply({ ...baseRunOpts, name: 'javaopt', monocerosHome: home });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'javaopt',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    // installMaven:false from the yml wins over the catalog default (true);
    // installGradle keeps its default (true); version from the object form.
    expect(
      devcontainer.features['ghcr.io/devcontainers/features/java:1'],
    ).toEqual({ installMaven: false, installGradle: true, version: '17' });
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

  it('`node:22` (the base-image version) also stays builtin, no node feature', async () => {
    await writeYml(
      'node-pinned-builtin',
      [
        'schemaVersion: 1',
        'name: node-pinned-builtin',
        'languages:',
        '  - node:22',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'node-pinned-builtin',
      monocerosHome: home,
    });
    const devcontainer = JSON.parse(
      await readFile(
        path.join(
          home,
          'container',
          'node-pinned-builtin',
          '.devcontainer',
          'devcontainer.json',
        ),
        'utf8',
      ),
    );
    // node:22 == the builtin base-image version → no upstream node feature.
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
      // Resolved from the pin writeYml injects (ADR 0017).
      runtimeImage: 'ghcr.io/getmonoceros/monoceros-runtime:1.1.0',
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

  it('errors on a yml without runtimeVersion (no silent re-image — ADR 0017)', async () => {
    // Bypass the pin-injecting writeYml helper to get a genuinely
    // unpinned yml on disk.
    await writeFile(
      path.join(home, 'container-configs', 'unpinned.yml'),
      ['schemaVersion: 1', 'name: unpinned', ''].join('\n'),
    );
    await expect(
      runApply({ ...baseRunOpts, name: 'unpinned', monocerosHome: home }),
    ).rejects.toThrow(/No runtime pinned.*runtimeVersion/s);
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

  it('does NOT prompt for a container identity when every repo carries its own git.user', async () => {
    // Regression: a repo whose git.user resolves to literal values gets
    // its committer identity per-clone via post-create.sh. It must not
    // drive the container-wide identity prompt — no host identity, no
    // container git.user, no defaults, yet apply used to prompt anyway
    // because the mere presence of a repo triggered collection.
    await writeYml(
      'self-identified',
      [
        'schemaVersion: 1',
        'name: self-identified',
        'repos:',
        '  - url: https://github.com/work/api.git',
        '    git:',
        '      user:',
        '        name: Thorsten (work)',
        '        email: tk@conciso.de',
        '',
      ].join('\n'),
    );
    const promptedKeys: string[] = [];
    await runApply({
      ...baseRunOpts,
      name: 'self-identified',
      monocerosHome: home,
      identityPrompt: async (key: string) => {
        promptedKeys.push(key);
        return undefined;
      },
    });
    expect(promptedKeys).toEqual([]);
  });

  it('does NOT prompt when the container git.user placeholders resolve to blank and every repo self-identifies', async () => {
    // Regression: `init` always emits `git.user: ${GIT_USER_NAME}/…`, so
    // the block textually exists on nearly every yml. With the env vars
    // present-but-blank it resolves to nothing (no containerGitOverride).
    // The mere presence of the block must not force the prompt — the one
    // repo carries its own identity, so there's nothing left to collect.
    await writeYml(
      'blank-container-id',
      [
        'schemaVersion: 1',
        'name: blank-container-id',
        'git:',
        '  user:',
        '    name: ${GIT_USER_NAME}',
        '    email: ${GIT_USER_EMAIL}',
        'repos:',
        '  - url: https://github.com/work/api.git',
        '    git:',
        '      user:',
        '        name: Thorsten Kamann',
        '        email: tk@conciso.de',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(home, 'container-configs', 'blank-container-id.env'),
      'GIT_USER_NAME=\nGIT_USER_EMAIL=\n',
    );
    const promptedKeys: string[] = [];
    await runApply({
      ...baseRunOpts,
      name: 'blank-container-id',
      monocerosHome: home,
      identityPrompt: async (key: string) => {
        promptedKeys.push(key);
        return undefined;
      },
    });
    expect(promptedKeys).toEqual([]);
    // The repo still gets its own identity baked in per-clone.
    const postCreate = await readFile(
      path.join(
        home,
        'container',
        'blank-container-id',
        '.devcontainer',
        'post-create.sh',
      ),
      'utf8',
    );
    expect(postCreate).toContain(
      'git -C "projects/api" config user.name "Thorsten Kamann"',
    );
  });

  it('still prompts for a container identity when a repo lacks its own git.user', async () => {
    // Guard against over-skipping: a repo with no git.user still needs
    // the container-wide fallback identity, so the prompt must fire when
    // the cascade has nothing else (no host identity in the stub).
    await writeYml(
      'needs-identity',
      [
        'schemaVersion: 1',
        'name: needs-identity',
        'repos:',
        '  - url: https://github.com/work/api.git',
        '',
      ].join('\n'),
    );
    const promptedKeys: string[] = [];
    await runApply({
      ...baseRunOpts,
      name: 'needs-identity',
      monocerosHome: home,
      identityPrompt: async (key: string) => {
        promptedKeys.push(key);
        return undefined;
      },
    });
    expect(promptedKeys.length).toBeGreaterThan(0);
  });

  it('resolves ${VAR} in per-repo git.user from <name>.env', async () => {
    await writeYml(
      'repo-env-id',
      [
        'schemaVersion: 1',
        'name: repo-env-id',
        'repos:',
        '  - url: https://github.com/work/api.git',
        '    git:',
        '      user:',
        '        name: ${GIT_USER_NAME}',
        '        email: ${GIT_USER_EMAIL}',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(home, 'container-configs', 'repo-env-id.env'),
      'GIT_USER_NAME=Thorsten\nGIT_USER_EMAIL=tk@conciso.de\n',
    );
    await runApply({
      ...baseRunOpts,
      name: 'repo-env-id',
      monocerosHome: home,
    });
    const postCreate = await readFile(
      path.join(
        home,
        'container',
        'repo-env-id',
        '.devcontainer',
        'post-create.sh',
      ),
      'utf8',
    );
    expect(postCreate).toContain(
      'git -C "projects/api" config user.name "Thorsten"',
    );
    expect(postCreate).toContain(
      'git -C "projects/api" config user.email "tk@conciso.de"',
    );
  });

  it('drops the per-repo override when a ${VAR} is missing from the env (falls through to cascade)', async () => {
    await writeYml(
      'repo-missing-id',
      [
        'schemaVersion: 1',
        'name: repo-missing-id',
        'repos:',
        '  - url: https://github.com/work/api.git',
        '    git:',
        '      user:',
        '        name: ${GIT_USER_NAME}',
        '        email: ${GIT_USER_EMAIL}',
        '',
      ].join('\n'),
    );
    // No .env → both vars unresolved → whole override dropped.
    await runApply({
      ...baseRunOpts,
      name: 'repo-missing-id',
      monocerosHome: home,
    });
    const postCreate = await readFile(
      path.join(
        home,
        'container',
        'repo-missing-id',
        '.devcontainer',
        'post-create.sh',
      ),
      'utf8',
    );
    // No per-repo override baked in — the placeholder never leaks through.
    expect(postCreate).not.toContain('git -C "projects/api" config user.name');
    expect(postCreate).not.toContain('${GIT_USER_NAME}');
  });

  it('drops the per-repo override when the env vars are seeded but empty (climbs cascade)', async () => {
    await writeYml(
      'repo-empty-id',
      [
        'schemaVersion: 1',
        'name: repo-empty-id',
        'repos:',
        '  - url: https://github.com/work/api.git',
        '    git:',
        '      user:',
        '        name: ${GIT_USER_NAME}',
        '        email: ${GIT_USER_EMAIL}',
        '',
      ].join('\n'),
    );
    // The builder prepared the keys but hasn't filled them — empty must
    // mean "unset → climb the cascade", NOT an empty/invalid identity.
    await writeFile(
      path.join(home, 'container-configs', 'repo-empty-id.env'),
      'GIT_USER_NAME=\nGIT_USER_EMAIL=\n',
    );
    await runApply({
      ...baseRunOpts,
      name: 'repo-empty-id',
      monocerosHome: home,
    });
    const postCreate = await readFile(
      path.join(
        home,
        'container',
        'repo-empty-id',
        '.devcontainer',
        'post-create.sh',
      ),
      'utf8',
    );
    expect(postCreate).not.toContain('git -C "projects/api" config user.name');
    expect(postCreate).not.toContain('${GIT_USER_NAME}');
    expect(postCreate).not.toContain('config user.email ""');
  });

  it('errors when a resolved git.user.email is malformed', async () => {
    await writeYml(
      'repo-bad-id',
      [
        'schemaVersion: 1',
        'name: repo-bad-id',
        'repos:',
        '  - url: https://github.com/work/api.git',
        '    git:',
        '      user:',
        '        name: ${GIT_USER_NAME}',
        '        email: ${GIT_USER_EMAIL}',
        '',
      ].join('\n'),
    );
    await writeFile(
      path.join(home, 'container-configs', 'repo-bad-id.env'),
      'GIT_USER_NAME=Thorsten\nGIT_USER_EMAIL=not-an-email\n',
    );
    await expect(
      runApply({ ...baseRunOpts, name: 'repo-bad-id', monocerosHome: home }),
    ).rejects.toThrow(/not a valid email/);
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

  it('post-create.sh clones with the userinfo stripped from the repo URL', async () => {
    // Bitbucket copy-paste URLs embed the account name
    // (`https://alice@bitbucket.org/…`); git would then look up a
    // credential for `alice` and miss our host-keyed token entry. The
    // clone must run against the userinfo-free URL (ADR 0031).
    await writeYml(
      'embedded-user',
      [
        'schemaVersion: 1',
        'name: embedded-user',
        'repos:',
        '  - url: https://alice@bitbucket.org/team/app.git',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      env: { GIT_TOKEN__BITBUCKET: 'atatt_x' },
      name: 'embedded-user',
      monocerosHome: home,
    });
    const postCreate = await readFile(
      path.join(
        home,
        'container',
        'embedded-user',
        '.devcontainer',
        'post-create.sh',
      ),
      'utf8',
    );
    expect(postCreate).toContain(
      'git clone "https://bitbucket.org/team/app.git"',
    );
    expect(postCreate).not.toContain('alice@bitbucket.org');
  });

  it('does NOT abort when a repo has no token — warns at the end instead', async () => {
    // A missing token is non-fatal (public repos clone read-only). apply
    // proceeds and prints a prominent unauthenticated-repos warning that
    // names the consequences and the vars to set.
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
    let out = '';
    const progressOut = new Writable({
      write(chunk, _enc, cb): void {
        out += chunk.toString();
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    const result = await runApply({
      ...baseRunOpts,
      env: {}, // no token for any host
      progressOut,
      name: 'no-creds',
      monocerosHome: home,
    });
    expect(result.containerExitCode).toBe(0);
    expect(out).toContain('UNAUTHENTICATED');
    expect(out).toContain('github.com');
    expect(out).toContain('GITHUB_API_TOKEN');
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

  it('shows the unauthenticated-repos warning on a FAILED apply too', async () => {
    // A private repo with no token fails the in-container clone (post-create),
    // so apply exits non-zero — exactly when the "set a token" warning is
    // most useful. It must appear on the failure path as well.
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
    let out = '';
    const progressOut = new Writable({
      write(chunk, _enc, cb): void {
        out += chunk.toString();
        cb();
      },
    }) as unknown as NodeJS.WriteStream;
    const result = await runApply({
      ...baseRunOpts,
      env: {},
      // Simulate the in-container clone failing (private repo, no token).
      devcontainerSpawn: async () => 1,
      progressOut,
      name: 'no-creds',
      monocerosHome: home,
    });
    expect(result.containerExitCode).toBe(1);
    expect(out).toContain('UNAUTHENTICATED');
    expect(out).toContain('GITHUB_API_TOKEN');
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

  // ADR 0031: a provider CLI feature with no repo but several org tokens
  // is ambiguous — apply prompts, then remembers the pick as a
  // <name>.env reference so the next apply resolves it without asking.
  it('prompts for an ambiguous feature token and persists the pick to <name>.env', async () => {
    await writeYml(
      'featonly',
      [
        'schemaVersion: 1',
        'name: featonly',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/github-cli:1',
        '',
      ].join('\n'),
    );
    const asked: string[] = [];
    await runApply({
      ...baseRunOpts,
      name: 'featonly',
      monocerosHome: home,
      // No provider-wide token here, only two org-keyed candidates.
      env: {
        GIT_TOKEN__GITHUB_KUNDE1: 'ghp_k1',
        GIT_TOKEN__GITHUB_KUNDE2: 'ghp_k2',
      },
      featureTokenPrompt: async (ctx) => {
        asked.push(...ctx.candidates);
        return 'GIT_TOKEN__GITHUB_KUNDE2';
      },
    });

    expect(asked).toEqual([
      'GIT_TOKEN__GITHUB_KUNDE1',
      'GIT_TOKEN__GITHUB_KUNDE2',
    ]);
    const envText = await readFile(
      path.join(home, 'container-configs', 'featonly.env'),
      'utf8',
    );
    expect(envText).toContain('GITHUB_API_TOKEN=${GIT_TOKEN__GITHUB_KUNDE2}');
  });

  // Real-world case: init/scaffold seeds an empty `GITHUB_API_TOKEN=`
  // placeholder in <name>.env. The pick must OVERWRITE that line in
  // place, not be dropped as "already present" (which left the file
  // untouched and re-prompted on every apply).
  it('overwrites an empty <P>_API_TOKEN placeholder with the pick reference', async () => {
    await writeYml(
      'featseed',
      [
        'schemaVersion: 1',
        'name: featseed',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/github-cli:1',
        '',
      ].join('\n'),
    );
    const envFile = path.join(home, 'container-configs', 'featseed.env');
    await writeFile(
      envFile,
      [
        '# Secrets and values for ${VAR} references in featseed.yml.',
        'GITHUB_API_TOKEN=',
        'GIT_TOKEN__GITHUB_KUNDE1=ghp_k1',
        'GIT_TOKEN__GITHUB_KUNDE2=ghp_k2',
        '',
      ].join('\n'),
    );
    await runApply({
      ...baseRunOpts,
      name: 'featseed',
      monocerosHome: home,
      env: {}, // read the seeded file, not the provider-wide stub
      featureTokenPrompt: async () => 'GIT_TOKEN__GITHUB_KUNDE1',
    });

    const envText = await readFile(envFile, 'utf8');
    expect(envText).toContain('GITHUB_API_TOKEN=${GIT_TOKEN__GITHUB_KUNDE1}');
    // The empty placeholder was replaced in place, not duplicated.
    expect(envText.match(/^GITHUB_API_TOKEN=/gm)).toHaveLength(1);
  });

  it('leaves an already-filled <P>_API_TOKEN untouched (no re-prompt path)', async () => {
    // A non-empty GITHUB_API_TOKEN resolves directly (layer 1) — no
    // ambiguity, no prompt, no rewrite.
    await writeYml(
      'featfilled',
      [
        'schemaVersion: 1',
        'name: featfilled',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/github-cli:1',
        '',
      ].join('\n'),
    );
    const envFile = path.join(home, 'container-configs', 'featfilled.env');
    await writeFile(envFile, 'GITHUB_API_TOKEN=ghp_direct\n');
    let prompted = false;
    await runApply({
      ...baseRunOpts,
      name: 'featfilled',
      monocerosHome: home,
      env: {},
      featureTokenPrompt: async () => {
        prompted = true;
        return null;
      },
    });
    expect(prompted).toBe(false);
    const envText = await readFile(envFile, 'utf8');
    expect(envText).toContain('GITHUB_API_TOKEN=ghp_direct');
  });

  it('skipping an ambiguous feature token leaves it unauthenticated (non-fatal)', async () => {
    await writeYml(
      'featskip',
      [
        'schemaVersion: 1',
        'name: featskip',
        'features:',
        '  - ref: ghcr.io/getmonoceros/monoceros-features/github-cli:1',
        '',
      ].join('\n'),
    );
    // No throw despite no token; the pick returns null (skip).
    await runApply({
      ...baseRunOpts,
      name: 'featskip',
      monocerosHome: home,
      env: {
        GIT_TOKEN__GITHUB_KUNDE1: 'ghp_k1',
        GIT_TOKEN__GITHUB_KUNDE2: 'ghp_k2',
      },
      featureTokenPrompt: async () => null,
    });
    // Nothing persisted when skipped.
    const envPath = path.join(home, 'container-configs', 'featskip.env');
    let envText = '';
    try {
      envText = await readFile(envPath, 'utf8');
    } catch {
      /* file may not exist — also fine */
    }
    expect(envText).not.toContain('GITHUB_API_TOKEN=');
  });
});
