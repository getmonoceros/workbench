import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import type { FeatureEntry } from '../src/config/schema.js';
import {
  installPlugins,
  pluginCredentialHosts,
  resolvePluginSources,
} from '../src/apply/plugins.js';

const CLAUDE = 'ghcr.io/getmonoceros/monoceros-features/claude-code:1';

function config(plugins: unknown): unknown {
  return {
    schemaVersion: 1,
    name: 'demo',
    features: [{ ref: CLAUDE, options: { permissionMode: 'auto' }, plugins }],
  };
}

describe('plugins: in the yml', () => {
  it('accepts a marketplace url with the plugins to install', () => {
    const parsed = validateConfig(
      config([
        {
          url: 'https://github.com/acme/claude-plugins.git',
          enable: ['acme-conventions'],
        },
      ]),
    );
    expect(parsed.features[0]?.plugins?.[0]?.enable).toEqual([
      'acme-conventions',
    ]);
  });

  it('accepts a marketplace already checked out under projects/', () => {
    const parsed = validateConfig(
      config([{ path: 'house-plugins', enable: ['house-conventions'] }]),
    );
    expect(parsed.features[0]?.plugins?.[0]?.path).toBe('house-plugins');
  });

  // The whole point of the required field: a marketplace can hold several
  // plugins, so "install what is in there" is never a safe default.
  it('refuses a marketplace that names no plugin', () => {
    expect(() =>
      validateConfig(config([{ url: 'https://github.com/acme/p.git' }])),
    ).toThrow(/features\.0\.plugins\.0\.enable/);
    expect(() =>
      validateConfig(
        config([{ url: 'https://github.com/acme/p.git', enable: [] }]),
      ),
    ).toThrow(/at least one plugin/);
  });

  it('refuses a marketplace that is both remote and local, or neither', () => {
    expect(() =>
      validateConfig(
        config([
          {
            url: 'https://github.com/acme/p.git',
            path: 'p',
            enable: ['x'],
          },
        ]),
      ),
    ).toThrow(/either `url` or `path`/);
    expect(() => validateConfig(config([{ enable: ['x'] }]))).toThrow(
      /needs `url` .* or `path`/,
    );
  });

  // No `owner/repo` shorthand: it silently means GitHub, and a builder on
  // GitLab or Bitbucket would have no way to say otherwise.
  it('refuses a shorthand and an ssh url, like repos does', () => {
    expect(() =>
      validateConfig(config([{ url: 'acme/claude-plugins', enable: ['x'] }])),
    ).toThrow(/Only HTTPS URLs are supported/);
    expect(() =>
      validateConfig(
        config([{ url: 'git@github.com:acme/p.git', enable: ['x'] }]),
      ),
    ).toThrow(/Only HTTPS URLs are supported/);
  });

  it('refuses a provider on a marketplace that is never fetched', () => {
    expect(() =>
      validateConfig(
        config([{ path: 'house-plugins', provider: 'gitlab', enable: ['x'] }]),
      ),
    ).toThrow(/`provider` belongs to a `url` marketplace/);
  });
});

describe('resolvePluginSources', () => {
  it('hands the agent CLI the url as written', () => {
    const features: FeatureEntry[] = [
      {
        ref: CLAUDE,
        plugins: [
          {
            url: 'https://github.com/acme/claude-plugins.git',
            enable: ['acme-conventions'],
          },
        ],
      },
    ];
    expect(resolvePluginSources(features, 'demo')).toEqual([
      {
        featureRef: CLAUDE,
        cli: 'claude',
        source: 'https://github.com/acme/claude-plugins.git',
        enable: ['acme-conventions'],
      },
    ]);
  });

  // The yml says where it is on the host side (`projects/…`, like a volume);
  // the CLI runs inside, where that is under the workspace folder.
  it('makes a workspace path absolute for the container', () => {
    const features: FeatureEntry[] = [
      {
        ref: CLAUDE,
        plugins: [{ path: 'house-plugins', enable: ['house-conventions'] }],
      },
    ];
    expect(resolvePluginSources(features, 'demo')[0]?.source).toBe(
      '/workspaces/demo/projects/house-plugins',
    );
  });

  it('rejects plugins on a feature whose agent cannot host them', () => {
    const features: FeatureEntry[] = [
      {
        ref: 'ghcr.io/getmonoceros/monoceros-features/github:1',
        plugins: [{ url: 'https://github.com/acme/p.git', enable: ['x'] }],
      },
    ];
    expect(() => resolvePluginSources(features, 'demo')).toThrow(
      /does not host agent plugins/,
    );
  });

  it('rejects plugins on a third-party feature, which has no descriptor', () => {
    const features: FeatureEntry[] = [
      {
        ref: 'ghcr.io/devcontainers/features/docker-in-docker:2',
        plugins: [{ url: 'https://github.com/acme/p.git', enable: ['x'] }],
      },
    ];
    expect(() => resolvePluginSources(features, 'demo')).toThrow(
      /does not host agent plugins/,
    );
  });
});

describe('pluginCredentialHosts', () => {
  it('passes remote marketplaces to the credential pre-flight, with their provider', () => {
    const features: FeatureEntry[] = [
      {
        ref: CLAUDE,
        plugins: [
          {
            url: 'https://git.acme.example/tooling/plugins.git',
            provider: 'gitlab',
            enable: ['acme-review'],
          },
          { path: 'house-plugins', enable: ['house-conventions'] },
        ],
      },
    ];
    expect(pluginCredentialHosts(features)).toEqual([
      {
        url: 'https://git.acme.example/tooling/plugins.git',
        provider: 'gitlab',
      },
    ]);
  });
});

describe('installPlugins', () => {
  const source = {
    featureRef: CLAUDE,
    cli: 'claude',
    source: 'https://github.com/acme/claude-plugins.git',
    enable: ['acme-conventions', 'acme-review'],
  };

  function recordingSpawn(codeFor: (args: string[]) => number) {
    const calls: string[][] = [];
    return {
      calls,
      spawn: async (args: string[]) => {
        calls.push(args);
        return codeFor(args);
      },
    };
  }

  it('registers the marketplace once, then installs each named plugin', async () => {
    const { calls, spawn } = recordingSpawn(() => 0);
    const result = await installPlugins({
      root: '/tmp/demo',
      sources: [source],
      spawn,
    });
    const commands = calls.map((c) => c.slice(c.indexOf('--') + 1).join(' '));
    expect(commands).toEqual([
      'claude plugin marketplace add https://github.com/acme/claude-plugins.git',
      'claude plugin install acme-conventions',
      'claude plugin install acme-review',
    ]);
    expect(result).toEqual({
      installed: ['acme-conventions', 'acme-review'],
      failures: [],
    });
  });

  // One unreachable marketplace is one cause, not one per plugin.
  it('skips the installs when the marketplace cannot be registered', async () => {
    const { calls, spawn } = recordingSpawn((args) =>
      args.includes('marketplace') ? 1 : 0,
    );
    const result = await installPlugins({
      root: '/tmp/demo',
      sources: [source],
      spawn,
    });
    expect(calls).toHaveLength(1);
    expect(result.installed).toEqual([]);
    expect(result.failures).toEqual([
      'https://github.com/acme/claude-plugins.git could not be registered (exit 1); acme-conventions, acme-review not installed',
    ]);
  });

  it('reports the plugin that failed and keeps installing the rest', async () => {
    const { spawn } = recordingSpawn((args) =>
      args.includes('acme-conventions') ? 3 : 0,
    );
    const result = await installPlugins({
      root: '/tmp/demo',
      sources: [source],
      spawn,
    });
    expect(result.installed).toEqual(['acme-review']);
    expect(result.failures).toEqual([
      'acme-conventions could not be installed from https://github.com/acme/claude-plugins.git (exit 3)',
    ]);
  });
});
