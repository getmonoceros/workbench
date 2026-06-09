import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCompletionScript } from '../src/commands/completion.js';
import { main } from '../src/main.js';
import {
  resolveCompletions,
  parseCompletionLine,
  COMPLETION_ALL_COMMANDS,
  COMPLETION_COMMAND_SPEC_KEYS,
} from '../src/completion/resolve.js';

const wiredSubcommands = Object.keys(
  (main.subCommands ?? {}) as Record<string, unknown>,
)
  .filter((n) => !n.startsWith('__')) // internal commands stay out of completion
  .sort();

// ─── Shell-wrapper scripts ────────────────────────────────────────

describe('renderCompletionScript', () => {
  it('bash wrapper calls `monoceros __complete --line --point`', () => {
    const bash = renderCompletionScript('bash');
    expect(bash).toContain(
      'monoceros __complete --line "$COMP_LINE" --point "$COMP_POINT"',
    );
    expect(bash).toMatch(/complete -F _monoceros monoceros/);
  });

  it('bash wrapper suppresses trailing space when the candidate ends in `=`', () => {
    const bash = renderCompletionScript('bash');
    // The single-candidate-ends-with-`=` branch must be present; that's
    // the fix that keeps `--with-ports=3000` from becoming
    // `--with-ports =3000` after Tab + manual `=3000`.
    expect(bash).toContain('compopt -o nospace');
    expect(bash).toContain('"${COMPREPLY[0]}" == *=');
  });

  it("zsh wrapper applies `-S ''` (no suffix) to candidates ending in `=`", () => {
    const zsh = renderCompletionScript('zsh');
    expect(zsh).toContain("compadd -S '' --");
    expect(zsh).toContain('*= ');
  });

  it('zsh wrapper calls `monoceros __complete` with BUFFER+CURSOR', () => {
    const zsh = renderCompletionScript('zsh');
    expect(zsh).toContain(
      'monoceros __complete --line "$line" --point "$point"',
    );
    expect(zsh).toContain('local line="$BUFFER"');
    expect(zsh).toContain('local point="$CURSOR"');
    expect(zsh.startsWith('#compdef monoceros\n')).toBe(true);
  });

  it('pwsh wrapper calls `monoceros __complete` via Register-ArgumentCompleter', () => {
    const pwsh = renderCompletionScript('pwsh');
    expect(pwsh).toMatch(
      /Register-ArgumentCompleter -Native -CommandName monoceros/,
    );
    expect(pwsh).toContain('monoceros __complete --line $line --point $point');
  });

  it('wrappers contain no per-command name hardcoded — the engine knows them', () => {
    // The wrappers MUST NOT enumerate command names; that's the
    // resolver's job. Picking a few non-trivial command names that
    // would have appeared in the old scripts but shouldn't here.
    const bash = renderCompletionScript('bash');
    const zsh = renderCompletionScript('zsh');
    const pwsh = renderCompletionScript('pwsh');
    for (const name of ['add-feature', 'list-components', 'add-from-url']) {
      expect(bash).not.toContain(name);
      expect(zsh).not.toContain(name);
      expect(pwsh).not.toContain(name);
    }
  });
});

// ─── Spec / main.ts contract ──────────────────────────────────────

describe('completion spec registry', () => {
  it('COMPLETION_ALL_COMMANDS matches every wired user-facing subcommand', () => {
    expect([...COMPLETION_ALL_COMMANDS].sort()).toEqual(wiredSubcommands);
  });

  it('every wired user-facing subcommand has a spec entry (or empty spec)', () => {
    for (const name of wiredSubcommands) {
      expect(COMPLETION_COMMAND_SPEC_KEYS).toContain(name);
    }
  });
});

// ─── Tokenizer / cursor parser ────────────────────────────────────

describe('parseCompletionLine', () => {
  it('splits on whitespace, returning empty current at end-of-space', () => {
    const r = parseCompletionLine('monoceros init ', 'monoceros init '.length);
    expect(r.prev).toEqual(['monoceros', 'init']);
    expect(r.current).toBe('');
  });

  it('peels the last partial token as `current`', () => {
    const r = parseCompletionLine('monoceros ini', 'monoceros ini'.length);
    expect(r.prev).toEqual(['monoceros']);
    expect(r.current).toBe('ini');
  });

  it('respects single and double quoting', () => {
    const r = parseCompletionLine(
      `monoceros apply "my container" `,
      `monoceros apply "my container" `.length,
    );
    expect(r.prev).toEqual(['monoceros', 'apply', 'my container']);
    expect(r.current).toBe('');
  });

  it('treats `--flag=value` as a single token', () => {
    const r = parseCompletionLine(
      'monoceros init demo --with-features=no',
      'monoceros init demo --with-features=no'.length,
    );
    expect(r.prev).toEqual(['monoceros', 'init', 'demo']);
    expect(r.current).toBe('--with-features=no');
  });

  it('handles cursor before end of buffer', () => {
    const line = 'monoceros init demo --with-features=node,';
    const r = parseCompletionLine(
      line,
      'monoceros init demo --with-features=no'.length,
    );
    expect(r.prev).toEqual(['monoceros', 'init', 'demo']);
    expect(r.current).toBe('--with-features=no');
  });
});

// ─── Resolver ─────────────────────────────────────────────────────

describe('resolveCompletions', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'monoceros-comp-'));
    await mkdir(path.join(home, 'container-configs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('with no command typed yet → suggests all subcommands', async () => {
    const r = await resolveCompletions('monoceros ', 'monoceros '.length);
    expect(r).toContain('init');
    expect(r).toContain('apply');
    expect(r).toContain('add-feature');
  });

  it('prefix-filters subcommand suggestions against the partial token', async () => {
    const r = await resolveCompletions(
      'monoceros add-',
      'monoceros add-'.length,
    );
    expect(r).toContain('add-feature');
    expect(r).toContain('add-repo');
    expect(r).not.toContain('apply');
  });

  it('lists existing container names for `apply <NAME>`', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    await writeFile(path.join(home, 'container-configs', 'work.yml'), '');
    const r = await resolveCompletions(
      'monoceros apply ',
      'monoceros apply '.length,
      { monocerosHome: home },
    );
    expect(r).toEqual(['sandbox', 'work']);
  });

  it('prefix-filters container names against the partial token', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    await writeFile(path.join(home, 'container-configs', 'work.yml'), '');
    const r = await resolveCompletions(
      'monoceros apply san',
      'monoceros apply san'.length,
      { monocerosHome: home },
    );
    expect(r).toEqual(['sandbox']);
  });

  it('init has no positional suggestion (fresh name)', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const r = await resolveCompletions(
      'monoceros init ',
      'monoceros init '.length,
      { monocerosHome: home },
    );
    // No suggestions for the fresh-name slot — otherwise users would
    // accidentally collide with existing configs.
    expect(r).toEqual([]);
  });

  it('run surfaces --in after the container name', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const r = await resolveCompletions(
      'monoceros run sandbox ',
      'monoceros run sandbox '.length,
      { monocerosHome: home },
    );
    expect(r).toContain('--in=');
  });

  it('does not leak run --in into the inner command after `--`', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const r = await resolveCompletions(
      'monoceros run sandbox -- ',
      'monoceros run sandbox -- '.length,
      { monocerosHome: home },
    );
    // Past `--` we are completing the inner command, not monoceros flags.
    expect(r).not.toContain('--in=');
    expect(r).toEqual([]);
  });

  it('login lists login-capable tools of the named container', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'box.yml'),
      'schemaVersion: 1\nname: box\nfeatures:\n  - ref: ghcr.io/getmonoceros/monoceros-features/claude-code:1\n',
    );
    const r = await resolveCompletions(
      'monoceros login box ',
      'monoceros login box '.length,
      { monocerosHome: home },
    );
    expect(r).toEqual(['claude']);
  });

  it('login suggests nothing for a container without a login-capable tool', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'plain.yml'),
      'schemaVersion: 1\nname: plain\nfeatures:\n  - ref: ghcr.io/devcontainers/features/node:1\n',
    );
    const r = await resolveCompletions(
      'monoceros login plain ',
      'monoceros login plain '.length,
      { monocerosHome: home },
    );
    expect(r).toEqual([]);
  });

  it('init --w suggests the per-category value-flags with trailing `=`', async () => {
    const r = await resolveCompletions(
      'monoceros init demo --w',
      'monoceros init demo --w'.length,
    );
    // Trailing `=` is part of the candidate so the shell wrappers can
    // suppress the auto-added trailing space — without that the
    // builder ends up with `--with-ports =3000` after typing `=3000`.
    expect(r).toContain('--with-languages=');
    expect(r).toContain('--with-features=');
    expect(r).toContain('--with-services=');
    expect(r).toContain('--with-apt-packages=');
    expect(r).toContain('--with-repos=');
    expect(r).toContain('--with-ports=');
    // the old magic flag is gone
    expect(r).not.toContain('--with=');
  });

  it('init --with-features= suggests catalog feature short names', async () => {
    const r = await resolveCompletions(
      'monoceros init demo --with-features=',
      'monoceros init demo --with-features='.length,
    );
    expect(r).toContain('--with-features=claude');
    expect(r).toContain('--with-features=atlassian/twg');
    // languages are not features
    expect(r).not.toContain('--with-features=node');
  });

  it('init --with-languages= suggests language runtimes', async () => {
    const r = await resolveCompletions(
      'monoceros init demo --with-languages=',
      'monoceros init demo --with-languages='.length,
    );
    expect(r).toContain('--with-languages=node');
    expect(r).toContain('--with-languages=rust');
  });

  it('init --with-services= suggests curated service names', async () => {
    const r = await resolveCompletions(
      'monoceros init demo --with-services=',
      'monoceros init demo --with-services='.length,
    );
    expect(r).toContain('--with-services=postgres');
  });

  it('init --with-features=cla filters by prefix', async () => {
    const r = await resolveCompletions(
      'monoceros init demo --with-features=cla',
      'monoceros init demo --with-features=cla'.length,
    );
    expect(r).toContain('--with-features=claude');
    expect(r).not.toContain('--with-features=atlassian/twg');
  });

  it('init --with-languages=node, suggests next values after the comma', async () => {
    const r = await resolveCompletions(
      'monoceros init demo --with-languages=node,',
      'monoceros init demo --with-languages=node,'.length,
    );
    expect(r).toContain('--with-languages=node,rust');
  });

  it('add-feature <name> <fragment> suggests feature short names', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const r = await resolveCompletions(
      'monoceros add-feature sandbox atl',
      'monoceros add-feature sandbox atl'.length,
      { monocerosHome: home },
    );
    expect(r).toContain('atlassian');
    expect(r).toContain('atlassian/twg');
    expect(r).toContain('atlassian/rovodev');
    expect(r).not.toContain('node'); // languages are filtered out
  });

  it('add-language <name> <fragment> suggests language values', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const r = await resolveCompletions(
      'monoceros add-language sandbox no',
      'monoceros add-language sandbox no'.length,
      { monocerosHome: home },
    );
    expect(r).toContain('node');
  });

  it('add-repo --provider= suggests the known provider values', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const r = await resolveCompletions(
      'monoceros add-repo sandbox https://x.y/z.git --provider=',
      'monoceros add-repo sandbox https://x.y/z.git --provider='.length,
      { monocerosHome: home },
    );
    // Preserves the declaration order from PROVIDER_VALUES — no
    // alphabetic sort so the most-common (github/gitlab/bitbucket)
    // appear first.
    expect(r).toEqual([
      '--provider=github',
      '--provider=gitlab',
      '--provider=bitbucket',
      '--provider=gitea',
    ]);
  });

  it('completion <fragment> suggests shell names', async () => {
    const r = await resolveCompletions(
      'monoceros completion ',
      'monoceros completion '.length,
    );
    expect(r).toEqual(['bash', 'zsh', 'pwsh']);
  });

  it('falls through to flag names once past all expected positionals', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const r = await resolveCompletions(
      'monoceros apply sandbox ',
      'monoceros apply sandbox '.length,
      { monocerosHome: home },
    );
    // Past the container positional → flags surface without the
    // builder having to start with a `-` first.
    expect(r).toContain('--yes');
    expect(r).toContain('-y');
  });

  it('init fresh-name slot suggests nothing, but past it suggests the --with-* flags', async () => {
    // `monoceros init <TAB>` is inside the fresh-name positional —
    // no completions (would invite collisions with existing configs).
    const r1 = await resolveCompletions(
      'monoceros init ',
      'monoceros init '.length,
    );
    expect(r1).toEqual([]);
    // `monoceros init hello <TAB>` is past the fresh-name positional
    // → the per-category flags surface so Tab discovers them without
    // the builder having to know they exist.
    const r2 = await resolveCompletions(
      'monoceros init hello ',
      'monoceros init hello '.length,
    );
    expect(r2).toEqual(
      expect.arrayContaining([
        '--with-languages=',
        '--with-features=',
        '--with-services=',
        '--with-apt-packages=',
        '--with-repos=',
        '--with-ports=',
      ]),
    );
  });

  it('returns flag list when typing a leading dash after positionals', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const r = await resolveCompletions(
      'monoceros apply sandbox -',
      'monoceros apply sandbox -'.length,
      { monocerosHome: home },
    );
    expect(r).toContain('-y');
    expect(r).toContain('--yes');
  });

  it('unknown subcommand → no suggestions', async () => {
    const r = await resolveCompletions(
      'monoceros bogus sand',
      'monoceros bogus sand'.length,
    );
    expect(r).toEqual([]);
  });

  // ─── add-feature inner-args (post-`--` option keys) ──────────────

  describe('add-feature -- key=value inner args', () => {
    beforeEach(async () => {
      await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    });

    it('suggests every option key the feature manifest declares (short-name)', async () => {
      const line = 'monoceros add-feature sandbox atlassian -- ';
      const r = await resolveCompletions(line, line.length, {
        monocerosHome: home,
      });
      // The atlassian manifest declares six options. Each comes back
      // with a trailing `=` so the shell wrappers' nospace logic
      // engages — otherwise `email<TAB>=foo@x.de` becomes
      // `email =foo@x.de` (broken).
      expect(r).toEqual(
        expect.arrayContaining([
          'rovodev=',
          'twg=',
          'instance=',
          'email=',
          'apiToken=',
          'bitbucketToken=',
        ]),
      );
    });

    it('prefix-filters option names against the partial token', async () => {
      const line = 'monoceros add-feature sandbox atlassian -- api';
      const r = await resolveCompletions(line, line.length, {
        monocerosHome: home,
      });
      expect(r).toContain('apiToken=');
      // Doesn't leak unrelated keys.
      expect(r).not.toContain('rovodev=');
      expect(r).not.toContain('twg=');
    });

    it('drops options the builder has already set in earlier inner-args', async () => {
      const line = 'monoceros add-feature sandbox atlassian -- twg=true ';
      const r = await resolveCompletions(line, line.length, {
        monocerosHome: home,
      });
      // `twg` was already set, so no `twg=` suggestion this time.
      expect(r).not.toContain('twg=');
      // But the remaining keys are still on offer.
      expect(r).toContain('rovodev=');
      expect(r).toContain('apiToken=');
    });

    it('suggests `true` / `false` for boolean options after `key=`', async () => {
      const line = 'monoceros add-feature sandbox atlassian -- rovodev=';
      const r = await resolveCompletions(line, line.length, {
        monocerosHome: home,
      });
      expect(r).toEqual(['rovodev=true', 'rovodev=false']);
    });

    it('prefix-filters boolean values against the post-`=` fragment', async () => {
      const line = 'monoceros add-feature sandbox atlassian -- rovodev=t';
      const r = await resolveCompletions(line, line.length, {
        monocerosHome: home,
      });
      expect(r).toEqual(['rovodev=true']);
    });

    it('returns [] for string-typed values (no useful suggestion list)', async () => {
      const line = 'monoceros add-feature sandbox atlassian -- instance=';
      const r = await resolveCompletions(line, line.length, {
        monocerosHome: home,
      });
      expect(r).toEqual([]);
    });

    it('resolves the feature ref from a full OCI ref (not just short names)', async () => {
      const line =
        'monoceros add-feature sandbox ghcr.io/getmonoceros/monoceros-features/atlassian:1 -- ';
      const r = await resolveCompletions(line, line.length, {
        monocerosHome: home,
      });
      expect(r).toContain('rovodev=');
      expect(r).toContain('twg=');
    });

    it('unknown feature → no inner-arg suggestions (silent, never throws)', async () => {
      const line = 'monoceros add-feature sandbox no-such-feature -- ';
      const r = await resolveCompletions(line, line.length, {
        monocerosHome: home,
      });
      expect(r).toEqual([]);
    });

    it('respects --yes flag between container name and feature (still resolves)', async () => {
      const line = 'monoceros add-feature sandbox atlassian --yes -- ';
      const r = await resolveCompletions(line, line.length, {
        monocerosHome: home,
      });
      expect(r).toContain('rovodev=');
    });
  });
});
