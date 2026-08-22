import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/schema.js';
import type { FeatureEntry } from '../src/config/schema.js';
import { stripAnsi } from '../src/util/format.js';
import {
  describePluginFailure,
  formatPluginFailures,
  marketplaceName,
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

describe('describePluginFailure', () => {
  // Verbatim from a real apply against a private marketplace with no token in
  // the workbench. The point of the renderer is this transcript, so it is the
  // fixture: an exit code told the builder nothing, the `fatal:` line tells
  // them everything.
  const REAL_AUTH_FAILURE = [
    "\u001b[31m✘\u001b[39m Failed to add marketplace: Failed to clone marketplace repository: Cloning into '/home/node/.claude/plugins/marketplaces/temp_1787423663644'...",
    'fatal: unable to get password from user',
    'Adding marketplace…',
    '',
  ].join('\n');

  it('names the cause git gave, not the exit code', () => {
    const { cause } = describePluginFailure(REAL_AUTH_FAILURE, 1);
    expect(cause).toContain('fatal: unable to get password from user');
    expect(cause).toContain('Failed to add marketplace');
    // The spinner remnant and the temp clone path are not the cause.
    expect(cause).not.toContain('Adding marketplace');
    expect(cause).not.toContain('Cloning into');
    expect(cause).not.toContain('temp_');
    expect(cause).toBe(
      'Failed to add marketplace: Failed to clone marketplace repository / fatal: unable to get password from user',
    );
    expect(cause).not.toMatch(/exit(ed)? 1/);
  });

  it('says what to do when git had no credentials', () => {
    const { hint } = describePluginFailure(REAL_AUTH_FAILURE, 1);
    expect(hint).toMatch(/private marketplace whose token is missing/);
  });

  it.each([
    'fatal: could not read Username for https://github.com: No such device',
    'remote: Invalid username or token.',
    'fatal: Authentication failed for https://git.acme.example/x.git',
  ])('recognises %s as an auth problem', (line) => {
    expect(describePluginFailure(line, 128).hint).toBeDefined();
  });

  it('offers no hint for a failure that is not about credentials', () => {
    const { cause, hint } = describePluginFailure(
      '✘ Plugin "acme-typo" not found in any marketplace\n',
      1,
    );
    expect(cause).toBe('Plugin "acme-typo" not found in any marketplace');
    expect(hint).toBeUndefined();
  });

  // Better a weak line than a number: the builder can search for it.
  it('falls back to the last line, and to the exit code only when silent', () => {
    expect(describePluginFailure('something odd happened\n', 2).cause).toBe(
      'something odd happened',
    );
    expect(describePluginFailure('', 2).cause).toBe(
      'the command exited 2 without output',
    );
  });
});

describe('installPlugins', () => {
  const source = {
    featureRef: CLAUDE,
    cli: 'claude',
    source: 'https://github.com/acme/claude-plugins.git',
    enable: ['acme-conventions', 'acme-review'],
  };

  function recordingSpawn(
    outcome: (args: string[]) => { code: number; output?: string },
  ) {
    const calls: string[][] = [];
    return {
      calls,
      spawn: async (
        args: string[],
        _cwd: string,
        options?: { progressSink?: NodeJS.WritableStream },
      ) => {
        calls.push(args);
        const { code, output } = outcome(args);
        if (output) options?.progressSink?.write(output);
        return code;
      },
    };
  }

  it('registers the marketplace once, then installs each named plugin', async () => {
    const { calls, spawn } = recordingSpawn(() => ({ code: 0 }));
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
  it('skips the installs when the marketplace cannot be registered, and carries the reason', async () => {
    const { calls, spawn } = recordingSpawn((args) =>
      args.includes('marketplace')
        ? { code: 1, output: 'fatal: unable to get password from user\n' }
        : { code: 0 },
    );
    const result = await installPlugins({
      root: '/tmp/demo',
      sources: [source],
      spawn,
    });
    expect(calls).toHaveLength(1);
    expect(result.installed).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.what).toBe(
      'could not register https://github.com/acme/claude-plugins.git, so acme-conventions, acme-review were not installed',
    );
    expect(result.failures[0]?.cause).toBe(
      'fatal: unable to get password from user',
    );
    expect(result.failures[0]?.hint).toBeDefined();
  });

  it('reports the plugin that failed and keeps installing the rest', async () => {
    const { spawn } = recordingSpawn((args) =>
      args.includes('acme-conventions')
        ? { code: 3, output: '✘ Plugin "acme-conventions" not found\n' }
        : { code: 0 },
    );
    const result = await installPlugins({
      root: '/tmp/demo',
      sources: [source],
      spawn,
    });
    expect(result.installed).toEqual(['acme-review']);
    expect(result.failures).toEqual([
      {
        what: 'could not install acme-conventions from https://github.com/acme/claude-plugins.git',
        cause: 'Plugin "acme-conventions" not found',
      },
    ]);
  });
});

describe('formatPluginFailures', () => {
  const block = () =>
    stripAnsi(
      formatPluginFailures(
        [
          {
            what: 'could not register https://github.com/acme/claude-plugins.git, so acme-conventions was not installed',
            cause: 'fatal: unable to get password from user',
            hint: 'Most often a private marketplace whose token is missing: set it in\n   the env file, same as for a private repo.',
          },
        ],
        'acme',
      ),
    );

  // The complaint this answers: four warnings, four shapes, four moments.
  // Whatever the repo-access block does, this one does too.
  it('uses the same warning vocabulary as the other end-of-apply blocks', () => {
    const lines = block().split('\n');
    expect(lines[0]).toBe('⚠  Agent plugins not installed');
    expect(lines[1]).toBe('');
    // Yellow lead-in, then bullets at the same depth as everywhere else.
    expect(lines[2]).toMatch(/^ {3}\S/);
    expect(lines.some((l) => l.startsWith('     • '))).toBe(true);
    expect(lines.at(-1)).toContain(
      'Details: https://getmonoceros.build/docs/concepts/git-and-repos/',
    );
  });

  it('carries the cause and the command that retries it', () => {
    expect(block()).toContain('fatal: unable to get password from user');
    expect(block()).toContain('monoceros apply acme');
  });

  // One cause, one hint, however many plugins it took down.
  it('does not repeat the same hint per failure', () => {
    const hint = 'set a token';
    const text = stripAnsi(
      formatPluginFailures(
        [
          { what: 'a', cause: 'x', hint },
          { what: 'b', cause: 'y', hint },
        ],
        'acme',
      ),
    );
    expect(text.split(hint)).toHaveLength(2);
  });
});

describe('marketplaceName', () => {
  // Both lines verbatim from the agent CLI. The name is the marketplace's
  // own, not one we picked, and this is where it is readable.
  it('reads the name and whether it was already there', () => {
    expect(
      marketplaceName(
        '\u001b[32m✔\u001b[39m Successfully added marketplace: monoceros-discovery (declared in user settings)',
      ),
    ).toEqual({ name: 'monoceros-discovery', alreadyPresent: false });
    expect(
      marketplaceName(
        "✔ Marketplace 'monoceros-discovery' already on disk — declared in user settings",
      ),
    ).toEqual({ name: 'monoceros-discovery', alreadyPresent: true });
  });

  it('gives up rather than guessing', () => {
    expect(marketplaceName('something else entirely')).toBeUndefined();
  });
});

describe('installPlugins refreshing an existing marketplace', () => {
  const source = {
    featureRef: CLAUDE,
    cli: 'claude',
    source: 'https://github.com/acme/claude-plugins.git',
    enable: ['acme-conventions'],
  };

  function run(
    addOutput: string,
    codeFor: (args: string[]) => number = () => 0,
  ) {
    const commands: string[][] = [];
    return {
      commands,
      result: installPlugins({
        root: '/tmp/demo',
        sources: [source],
        spawn: async (
          args: string[],
          _cwd: string,
          options?: { progressSink?: NodeJS.WritableStream },
        ) => {
          const cmd = args.slice(args.indexOf('--') + 1);
          commands.push(cmd);
          if (cmd.includes('add')) options?.progressSink?.write(addOutput);
          return codeFor(cmd);
        },
      }),
    };
  }

  // ~/.claude survives a rebuild, and `add` on an existing marketplace does
  // not pull. Without the refresh a workbench would stay on the version it
  // first cloned, forever.
  it('pulls the marketplace and the plugin when both were already there', async () => {
    const { commands, result } = run(
      "✔ Marketplace 'acme-plugins' already on disk",
    );
    await result;
    expect(commands.map((c) => c.join(' '))).toEqual([
      'claude plugin marketplace add https://github.com/acme/claude-plugins.git',
      'claude plugin marketplace update acme-plugins',
      'claude plugin install acme-conventions',
      'claude plugin update acme-conventions',
    ]);
  });

  it('skips the refresh on a marketplace it just cloned', async () => {
    const { commands, result } = run(
      '✔ Successfully added marketplace: acme-plugins (declared in user settings)',
    );
    await result;
    expect(commands.map((c) => c.join(' '))).toEqual([
      'claude plugin marketplace add https://github.com/acme/claude-plugins.git',
      'claude plugin install acme-conventions',
    ]);
  });

  it('reports a refresh that failed and leaves the old version alone', async () => {
    const { commands, result } = run(
      "✔ Marketplace 'acme-plugins' already on disk",
      (cmd) => (cmd.includes('marketplace') && cmd.includes('update') ? 1 : 0),
    );
    const { installed, failures } = await result;
    expect(commands).toHaveLength(2);
    expect(installed).toEqual([]);
    expect(failures[0]?.what).toContain('stayed at the version already in the');
  });
});
