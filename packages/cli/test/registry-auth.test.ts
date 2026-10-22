import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  pullPrivateImage,
  resolvePrivateImages,
} from '../src/apply/registry-auth.js';
import type { DockerExec } from '../src/proxy/index.js';

const SSP = 'ghcr.io/conciso/sspag-control-software/gotenberg:latest';

describe('resolvePrivateImages (ADR 0064)', () => {
  it('reads a GHCR image with the token of its owner', () => {
    const images = resolvePrivateImages([{ name: 'gotenberg', image: SSP }], {
      GIT_TOKEN__GITHUB_CONCISO: 'ghp_conciso',
      GIT_TOKEN__GITHUB_THORQUE: 'ghp_thorque',
    });
    expect(images).toEqual([
      {
        service: 'gotenberg',
        image: SSP,
        varName: 'GIT_TOKEN__GITHUB_CONCISO',
        token: 'ghp_conciso',
      },
    ]);
  });

  it('follows the repo cascade: GITHUB_API_TOKEN first, GIT_TOKEN__GITHUB last', () => {
    const svc = [{ name: 'gotenberg', image: SSP }];
    expect(
      resolvePrivateImages(svc, {
        GITHUB_API_TOKEN: 'ghp_feature',
        GIT_TOKEN__GITHUB_CONCISO: 'ghp_conciso',
      })[0]!.varName,
    ).toBe('GITHUB_API_TOKEN');
    expect(
      resolvePrivateImages(svc, { GIT_TOKEN__GITHUB: 'ghp_any' })[0]!.varName,
    ).toBe('GIT_TOKEN__GITHUB');
  });

  it('leaves other registries and images without a token to Docker', () => {
    expect(
      resolvePrivateImages(
        [
          {
            name: 'mssql',
            image: 'mcr.microsoft.com/mssql/server:2025-latest',
          },
          { name: 'pg', image: 'postgres:17' },
          { name: 'gotenberg', image: SSP },
        ],
        { GIT_TOKEN__GITHUB_THORQUE: 'ghp_thorque', GITHUB_API_TOKEN: ' ' },
      ),
    ).toEqual([]);
  });
});

describe('pullPrivateImage (ADR 0064)', () => {
  const img = {
    service: 'gotenberg',
    image: SSP,
    varName: 'GIT_TOKEN__GITHUB_CONCISO',
    token: 'ghp_conciso',
  };

  it('pulls through a throwaway config on the current context, and removes it', async () => {
    const exec: DockerExec = async (args) => ({
      stdout:
        args[0] === 'context'
          ? 'unix:///Users/u/.docker/run/docker.sock\n'
          : '/Users/u/.docker/cli-plugins/docker-compose\n',
      stderr: '',
      exitCode: 0,
    });
    let dockerArgs: string[] = [];
    let config = '';
    const exit = await pullPrivateImage(img, exec, async (args) => {
      dockerArgs = args;
      config = readFileSync(`${args[1]}/config.json`, 'utf8');
      return 0;
    });

    expect(exit).toBe(0);
    expect(dockerArgs[0]).toBe('--config');
    expect(dockerArgs.slice(2)).toEqual([
      '--host',
      'unix:///Users/u/.docker/run/docker.sock',
    ]);
    expect(dockerArgs.join(' ')).not.toContain('ghp_conciso');
    const auth = JSON.parse(config).auths['ghcr.io'].auth as string;
    expect(Buffer.from(auth, 'base64').toString()).toBe(
      'monoceros:ghp_conciso',
    );
    // A fresh config dir has no cli-plugins, so `compose` would be unknown.
    expect(JSON.parse(config).cliPluginsExtraDirs).toEqual([
      '/Users/u/.docker/cli-plugins',
    ]);
    expect(existsSync(dockerArgs[1]!)).toBe(false);
  });

  it('hands back the failing pull and still removes the config', async () => {
    const exec: DockerExec = async () => ({
      stdout: '',
      stderr: '',
      exitCode: 1,
    });
    let dir = '';
    const exit = await pullPrivateImage(img, exec, async (args) => {
      dir = args[1]!;
      expect(args).not.toContain('--host');
      return 1;
    });
    expect(exit).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });
});
