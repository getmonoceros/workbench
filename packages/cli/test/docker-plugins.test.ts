import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type PluginProbeOptions,
  defaultInstallDirs,
  formatBuildxUnavailableWarning,
  formatComposeUnavailableError,
  probeDockerPlugin,
} from '../src/devcontainer/docker-plugins.js';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('probeDockerPlugin', () => {
  let root: string;
  let configDir: string;
  let installDir: string;

  // A Docker CLI where no plugin runs: `<plugin> version` fails, and
  // `docker info` lists what `listed` says.
  const cliWith =
    (listed: unknown[] = []): PluginProbeOptions['exec'] =>
    async (args) =>
      args[0] === 'info'
        ? { exitCode: 0, stdout: JSON.stringify(listed), stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'unknown command' };
  const noStandalone = async () => {
    throw new Error('spawn docker-compose ENOENT');
  };
  const opts = (over: PluginProbeOptions = {}): PluginProbeOptions => ({
    exec: cliWith(),
    run: noStandalone,
    env: { HOME: root, DOCKER_CONFIG: configDir },
    systemDirs: [],
    installDirs: [installDir],
    ...over,
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'monoceros-plugins-'));
    configDir = path.join(root, '.docker');
    installDir = path.join(root, 'homebrew', 'lib', 'docker', 'cli-plugins');
    await mkdir(configDir, { recursive: true });
    await mkdir(installDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is ok when `docker <plugin> version` works', async () => {
    const exec = async () => ({ exitCode: 0, stdout: 'v5.3.0', stderr: '' });
    expect(await probeDockerPlugin('compose', opts({ exec }))).toEqual({
      kind: 'ok',
    });
  });

  it('accepts a standalone docker-compose, which devcontainer-cli falls back to', async () => {
    const run = async () => ({ exitCode: 0 });
    expect(await probeDockerPlugin('compose', opts({ run }))).toEqual({
      kind: 'ok',
    });
    // Buildx has no such fallback.
    expect((await probeDockerPlugin('buildx', opts({ run }))).kind).toBe(
      'missing',
    );
  });

  it('stays out of the way when docker itself cannot be spawned', async () => {
    const exec = async () => {
      throw new Error('spawn docker ENOENT');
    };
    expect(await probeDockerPlugin('compose', opts({ exec }))).toEqual({
      kind: 'unknown',
    });
  });

  it('reports a plugin the CLI finds but cannot run, with its error', async () => {
    const exec = cliWith([
      {
        Name: 'compose',
        Path: '/x/docker-compose',
        Err: 'failed to fetch metadata: exit status 2',
      },
    ]);
    expect(await probeDockerPlugin('compose', opts({ exec }))).toEqual({
      kind: 'broken',
      path: '/x/docker-compose',
      error: 'failed to fetch metadata: exit status 2',
    });
  });

  it('finds an installed plugin the CLI does not look at (#111: Homebrew next to Colima)', async () => {
    await writeFile(path.join(installDir, 'docker-compose'), '');
    expect(await probeDockerPlugin('compose', opts())).toEqual({
      kind: 'unregistered',
      installed: path.join(installDir, 'docker-compose'),
    });
  });

  it('finds a dead link in the plugin dir, and the install to relink it to', async () => {
    await mkdir(path.join(configDir, 'cli-plugins'));
    const link = path.join(configDir, 'cli-plugins', 'docker-buildx');
    await symlink('/gone/docker-buildx', link);
    expect(await probeDockerPlugin('buildx', opts())).toEqual({
      kind: 'dangling',
      link,
      target: '/gone/docker-buildx',
    });

    await writeFile(path.join(installDir, 'docker-buildx'), '');
    expect(await probeDockerPlugin('buildx', opts())).toMatchObject({
      kind: 'dangling',
      installed: path.join(installDir, 'docker-buildx'),
    });
  });

  it('also checks the dirs listed under cliPluginsExtraDirs', async () => {
    const extra = path.join(root, 'extra');
    await mkdir(extra);
    await symlink('/gone/docker-compose', path.join(extra, 'docker-compose'));
    await writeFile(
      path.join(configDir, 'config.json'),
      JSON.stringify({ cliPluginsExtraDirs: [extra] }),
    );
    expect((await probeDockerPlugin('compose', opts())).kind).toBe('dangling');
  });

  it('is missing when nothing is anywhere', async () => {
    expect(await probeDockerPlugin('compose', opts())).toEqual({
      kind: 'missing',
    });
  });

  it('knows where Rancher Desktop keeps its plugins', () => {
    expect(defaultInstallDirs({ HOME: '/Users/kim' })).toEqual(
      expect.arrayContaining([
        '/Users/kim/.rd/bin',
        '/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin',
      ]),
    );
  });
});

describe('formatComposeUnavailableError', () => {
  const env = { HOME: homedir() };
  const yml = path.join(
    homedir(),
    '.monoceros',
    'container-configs',
    'acme.yml',
  );

  it('prints the link commands with the real install path', () => {
    const msg = plain(
      formatComposeUnavailableError(
        'acme',
        yml,
        {
          kind: 'unregistered',
          installed: '/opt/homebrew/lib/docker/cli-plugins/docker-compose',
        },
        { env, platform: 'darwin' },
      ),
    );
    expect(msg).toContain(
      'The workbench acme has services in ~/.monoceros/container-configs/acme.yml, and services start through Docker Compose.',
    );
    expect(msg).toContain(
      'installed at /opt/homebrew/lib/docker/cli-plugins/docker-compose, but the Docker CLI does not look for plugins there',
    );
    expect(msg).toContain('  mkdir -p ~/.docker/cli-plugins');
    expect(msg).toContain(
      '  ln -sfn /opt/homebrew/lib/docker/cli-plugins/docker-compose ~/.docker/cli-plugins/docker-compose',
    );
    expect(msg).toContain('re-run monoceros apply acme');
  });

  it('quotes a path with a space, so the pasted command works (Rancher Desktop)', () => {
    const msg = plain(
      formatComposeUnavailableError(
        'acme',
        yml,
        {
          kind: 'unregistered',
          installed:
            '/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/docker-compose',
        },
        { env },
      ),
    );
    expect(msg).toContain(
      "  ln -sfn '/Applications/Rancher Desktop.app/Contents/Resources/resources/darwin/bin/docker-compose' ~/.docker/cli-plugins/docker-compose",
    );
  });

  it('honours DOCKER_CONFIG for the plugin dir', () => {
    const msg = plain(
      formatComposeUnavailableError(
        'acme',
        yml,
        { kind: 'unregistered', installed: '/p/docker-compose' },
        { env: { ...env, DOCKER_CONFIG: '/etc/dockercfg' } },
      ),
    );
    expect(msg).toContain(
      'ln -sfn /p/docker-compose /etc/dockercfg/cli-plugins/docker-compose',
    );
  });

  it('gives each platform its own install hint', () => {
    const render = (platform: NodeJS.Platform, e: NodeJS.ProcessEnv = env) =>
      plain(
        formatComposeUnavailableError(
          'acme',
          yml,
          { kind: 'missing' },
          { env: e, platform },
        ),
      );
    expect(render('darwin')).toContain('  brew install docker-compose');
    expect(render('linux')).toContain(
      '  sudo apt-get install docker-compose-plugin',
    );
    expect(render('linux', { ...env, WSL_DISTRO_NAME: 'Ubuntu' })).toContain(
      'WSL integration',
    );
  });

  it('names the dead link and its target', () => {
    const msg = plain(
      formatComposeUnavailableError(
        'acme',
        yml,
        {
          kind: 'dangling',
          link: path.join(
            homedir(),
            '.docker',
            'cli-plugins',
            'docker-compose',
          ),
          target: '/opt/homebrew/opt/docker-compose/bin/docker-compose',
        },
        { env, platform: 'darwin' },
      ),
    );
    expect(msg).toContain(
      '~/.docker/cli-plugins/docker-compose points to /opt/homebrew/opt/docker-compose/bin/docker-compose, which does not exist anymore',
    );
    expect(msg).toContain('  rm ~/.docker/cli-plugins/docker-compose');
    expect(msg).toContain('  brew install docker-compose');
  });

  it('names the error of a plugin that does not run', () => {
    const msg = plain(
      formatComposeUnavailableError(
        'acme',
        yml,
        {
          kind: 'broken',
          path: '/x/docker-compose',
          error: 'exec format error',
        },
        { env },
      ),
    );
    expect(msg).toContain('cannot run it: exec format error');
  });
});

describe('formatBuildxUnavailableWarning', () => {
  it('says what happens without Buildx and how to fix it', () => {
    const msg = plain(
      formatBuildxUnavailableWarning(
        {
          kind: 'unregistered',
          installed: '/opt/homebrew/lib/docker/cli-plugins/docker-buildx',
        },
        { env: { HOME: homedir() } },
      ),
    );
    expect(msg).toContain('legacy builder, which Docker has deprecated');
    expect(msg).toContain(
      '  ln -sfn /opt/homebrew/lib/docker/cli-plugins/docker-buildx ~/.docker/cli-plugins/docker-buildx',
    );
  });
});
