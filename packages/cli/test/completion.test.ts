import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCompletionScript } from '../src/commands/completion.js';
import { main } from '../src/main.js';
import {
  resolveCompletions,
  parseCompletionLine,
  buildPwshCompletionModel,
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
  it('bash wrapper calls `monoceros __complete --line --point`', async () => {
    const bash = await renderCompletionScript('bash');
    expect(bash).toContain(
      'monoceros __complete --line "$COMP_LINE" --point "$COMP_POINT"',
    );
    expect(bash).toMatch(/complete -F _monoceros monoceros/);
  });

  it('bash wrapper suppresses trailing space when the candidate ends in `=`', async () => {
    const bash = await renderCompletionScript('bash');
    // The single-candidate-ends-with-`=` branch must be present; that's
    // the fix that keeps `--with-ports=3000` from becoming
    // `--with-ports =3000` after Tab + manual `=3000`.
    expect(bash).toContain('compopt -o nospace');
    expect(bash).toContain('"${COMPREPLY[0]}" == *=');
  });

  it("zsh wrapper applies `-S ''` (no suffix) to candidates ending in `=`", async () => {
    const zsh = await renderCompletionScript('zsh');
    expect(zsh).toContain("compadd -S '' --");
    expect(zsh).toContain('*= ');
  });

  it('zsh wrapper calls `monoceros __complete` with BUFFER+CURSOR', async () => {
    const zsh = await renderCompletionScript('zsh');
    expect(zsh).toContain(
      'monoceros __complete --line "$line" --point "$point"',
    );
    expect(zsh).toContain('local line="$BUFFER"');
    expect(zsh).toContain('local point="$CURSOR"');
    expect(zsh.startsWith('#compdef monoceros\n')).toBe(true);
  });

  it('pwsh script is self-contained: registers a native completer, never calls `__complete`', async () => {
    const pwsh = await renderCompletionScript('pwsh');
    expect(pwsh).toMatch(
      /Register-ArgumentCompleter -Native -CommandName @\('monoceros', 'monoceros\.cmd', 'monoceros\.exe'\)/,
    );
    // The whole point on Windows: no per-Tab CLI/WSL round-trip.
    expect(pwsh).not.toContain('__complete');
  });

  it('pwsh script embeds the static model (commands + baked value lists)', async () => {
    const pwsh = await renderCompletionScript('pwsh');
    // Command names ARE part of the baked model here (unlike bash/zsh,
    // whose engine enumerates them live).
    expect(pwsh).toContain('add-feature');
    expect(pwsh).toContain('list-components');
    // A couple of baked static value lists.
    expect(pwsh).toContain('claude'); // a feature
    expect(pwsh).toContain('postgres'); // a service
    // Host-side dynamic lookups are wired by kind, no CLI call.
    expect(pwsh).toContain('containerName');
    expect(pwsh).toContain('__Monoceros_ContainerNames');
    expect(pwsh).toContain('__Monoceros_Targets');
  });

  it('bash/zsh wrappers contain no per-command name hardcoded — the engine knows them', async () => {
    // The thin wrappers MUST NOT enumerate command names; that's the
    // resolver's job. (The pwsh script is different: it bakes the model
    // in on purpose — covered above.)
    const bash = await renderCompletionScript('bash');
    const zsh = await renderCompletionScript('zsh');
    for (const name of ['add-feature', 'list-components', 'add-from-url']) {
      expect(bash).not.toContain(name);
      expect(zsh).not.toContain(name);
    }
  });
});

// ─── PowerShell static model ──────────────────────────────────────

describe('buildPwshCompletionModel', () => {
  it('lists every command and gives each a spec', async () => {
    const model = await buildPwshCompletionModel();
    expect([...model.commands].sort()).toEqual(
      [...COMPLETION_ALL_COMMANDS].sort(),
    );
    for (const cmd of COMPLETION_ALL_COMMANDS) {
      expect(model.specs[cmd]).toBeDefined();
    }
  });

  it('bakes static positional/flag values, tags dynamic ones by kind', async () => {
    const model = await buildPwshCompletionModel();

    // Static positional: add-language's 2nd slot carries baked runtimes.
    const langSlot = model.specs['add-language']!.positionals[1]!;
    expect('values' in langSlot && langSlot.values).toContain('node');

    // Static flag value: init --with-features carries baked feature names.
    const featFlag = model.specs['init']!.flags['--with-features']!;
    expect(featFlag.type).toBe('value');
    expect(
      featFlag.value && 'values' in featFlag.value && featFlag.value.values,
    ).toContain('claude');

    // Dynamic positional: container name is a kind, not baked values.
    expect(model.specs['apply']!.positionals[0]).toEqual({
      kind: 'containerName',
    });
    // Dynamic flag value: run --in resolves workspace dirs at Tab time.
    expect(model.specs['run']!.flags['--in']!.value).toEqual({
      kind: 'runInDir',
    });
    // status' 2nd positional degrades to app-only (services need YAML).
    expect(model.specs['status']!.positionals[1]).toEqual({
      kind: 'appOrService',
    });
  });

  it('leaves freeform value flags without a baked value list', async () => {
    const model = await buildPwshCompletionModel();
    // --with-ports takes a value but has no suggestion source, so no
    // baked value descriptor at all.
    const portsFlag = model.specs['init']!.flags['--with-ports']!;
    expect(portsFlag.type).toBe('value');
    expect(portsFlag.value).toBeUndefined();
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

  it('completes run --in with workspace directories (host-side, container off)', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    // Materialize a workspace tree: scaffolding + a cloned app with
    // nested source dirs and noise (node_modules / dot-dirs).
    const ws = path.join(home, 'container', 'sandbox');
    await mkdir(path.join(ws, '.devcontainer'), { recursive: true });
    await mkdir(path.join(ws, 'projects', 'myApp', 'src'), { recursive: true });
    await mkdir(
      path.join(ws, 'projects', 'myApp', 'node_modules', 'left-pad'),
      {
        recursive: true,
      },
    );
    await mkdir(path.join(ws, 'projects', 'myApp', '.git'), {
      recursive: true,
    });

    const r = await resolveCompletions(
      'monoceros run sandbox --in ',
      'monoceros run sandbox --in '.length,
      { monocerosHome: home },
    );
    expect(r).toContain('projects');
    expect(r).toContain('projects/myApp');
    expect(r).toContain('projects/myApp/src');
    // Noise stays out.
    expect(r).not.toContain('.devcontainer');
    expect(r).not.toContain('projects/myApp/node_modules');
    expect(r).not.toContain('projects/myApp/.git');
  });

  it('completes run --in=<frag> by prefix, re-emitting the --in= prefix', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const ws = path.join(home, 'container', 'sandbox');
    await mkdir(path.join(ws, 'projects', 'myApp'), { recursive: true });
    await mkdir(path.join(ws, 'home'), { recursive: true });

    const r = await resolveCompletions(
      'monoceros run sandbox --in=pro',
      'monoceros run sandbox --in=pro'.length,
      { monocerosHome: home },
    );
    expect(r).toContain('--in=projects');
    expect(r).toContain('--in=projects/myApp');
    expect(r).not.toContain('--in=home');
  });

  it('run --in keeps non-projects top-level dirs to one level (no data-tree flood)', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const ws = path.join(home, 'container', 'sandbox');
    // Service data writes a deep tree under `data/`; we offer `data`
    // but must not recurse into it (that's noise, never an `--in` target).
    await mkdir(path.join(ws, 'data', 'mysql', 'monoceros'), {
      recursive: true,
    });
    await mkdir(path.join(ws, 'projects', 'myApp', 'src'), { recursive: true });

    const r = await resolveCompletions(
      'monoceros run sandbox --in ',
      'monoceros run sandbox --in '.length,
      { monocerosHome: home },
    );
    expect(r).toContain('data');
    expect(r).not.toContain('data/mysql');
    expect(r).not.toContain('data/mysql/monoceros');
    // projects is still walked deeply.
    expect(r).toContain('projects/myApp/src');
  });

  it('completes <app> for `start <name>` from launch configs (host-side, container off)', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const ws = path.join(home, 'container', 'sandbox');
    for (const app of ['web', 'apps/api']) {
      await mkdir(path.join(ws, 'projects', app, '.monoceros'), {
        recursive: true,
      });
      await writeFile(
        path.join(ws, 'projects', app, '.monoceros', 'launch.json'),
        JSON.stringify({ configurations: [{ name: 'dev', command: 'x' }] }),
      );
    }
    // A project without a launch config must not show up.
    await mkdir(path.join(ws, 'projects', 'docs'), { recursive: true });

    const r = await resolveCompletions(
      'monoceros start sandbox ',
      'monoceros start sandbox '.length,
      { monocerosHome: home },
    );
    expect(r).toContain('web');
    expect(r).toContain('apps/api');
    expect(r).not.toContain('docs');
  });

  it('completes `status <name> <app|service>` with apps AND declared services', async () => {
    await writeFile(
      path.join(home, 'container-configs', 'sandbox.yml'),
      [
        'schemaVersion: 1',
        'runtimeVersion: 1.6.0',
        'name: sandbox',
        'services:',
        '  - name: postgres',
        '    image: postgres:16',
        '',
      ].join('\n'),
    );
    const ws = path.join(home, 'container', 'sandbox');
    await mkdir(path.join(ws, 'projects', 'web', '.monoceros'), {
      recursive: true,
    });
    await writeFile(
      path.join(ws, 'projects', 'web', '.monoceros', 'launch.json'),
      JSON.stringify({ configurations: [{ name: 'dev', command: 'x' }] }),
    );

    const r = await resolveCompletions(
      'monoceros status sandbox ',
      'monoceros status sandbox '.length,
      { monocerosHome: home },
    );
    expect(r).toContain('web'); // app
    expect(r).toContain('postgres'); // declared service
  });

  it("completes --target from the already-typed app's launch config", async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const ws = path.join(home, 'container', 'sandbox');
    await mkdir(path.join(ws, 'projects', 'web', '.monoceros'), {
      recursive: true,
    });
    await writeFile(
      path.join(ws, 'projects', 'web', '.monoceros', 'launch.json'),
      JSON.stringify({
        configurations: [
          { name: 'dev', command: 'x' },
          { name: 'storybook', command: 'y' },
        ],
      }),
    );

    const r = await resolveCompletions(
      'monoceros start sandbox web --target ',
      'monoceros start sandbox web --target '.length,
      { monocerosHome: home },
    );
    expect(r).toEqual(['dev', 'storybook']);
  });

  it('run --in with no materialized container yields no suggestions', async () => {
    await writeFile(path.join(home, 'container-configs', 'sandbox.yml'), '');
    const r = await resolveCompletions(
      'monoceros run sandbox --in ',
      'monoceros run sandbox --in '.length,
      { monocerosHome: home },
    );
    expect(r).toEqual([]);
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
