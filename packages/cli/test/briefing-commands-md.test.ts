import { defineCommand } from 'citty';
import { describe, expect, it } from 'vitest';
import { generateCommandsMd } from '../src/briefing/commands-md.js';

describe('commands.md generator', () => {
  it('renders each subcommand as H3 under its group label', () => {
    const subCommands = {
      apply: defineCommand({
        meta: {
          name: 'apply',
          group: 'lifecycle',
          description: 'Materialize the container from its yml.',
        },
        args: {
          name: {
            type: 'positional',
            description: 'Container name.',
            required: true,
          },
          yes: {
            type: 'boolean',
            description: 'Skip prompts.',
            alias: ['y'],
            default: false,
          },
        },
        run() {},
      }),
      'add-feature': defineCommand({
        meta: {
          name: 'add-feature',
          group: 'edit',
          description: 'Add a feature.',
        },
        args: {
          name: {
            type: 'positional',
            required: true,
            description: 'Container name.',
          },
          ref: {
            type: 'positional',
            required: true,
            description: 'Feature ref.',
          },
        },
        run() {},
      }),
    };
    const md = generateCommandsMd(subCommands);
    expect(md).toContain('# monoceros — Command reference');
    expect(md).toContain('## Container lifecycle');
    expect(md).toContain('## Edit container yml');
    expect(md).toContain('### `monoceros apply <name> [flags]`');
    expect(md).toContain('### `monoceros add-feature <name> <ref>`');
    expect(md).toContain('Materialize the container from its yml.');
    expect(md).toContain('- `--yes` / `-y` — Skip prompts.');
  });

  it('skips internal commands prefixed with underscore', () => {
    const subCommands = {
      apply: defineCommand({
        meta: { name: 'apply', group: 'lifecycle', description: 'apply' },
        args: { name: { type: 'positional', required: true } },
        run() {},
      }),
      __complete: defineCommand({
        meta: { name: '__complete', description: 'internal' },
        args: {},
        run() {},
      }),
    };
    const md = generateCommandsMd(subCommands);
    expect(md).toContain('monoceros apply');
    expect(md).not.toContain('__complete');
  });

  it('groups ungrouped commands under "Other"', () => {
    const subCommands = {
      odd: defineCommand({
        meta: { name: 'odd', description: 'No group.' },
        args: {},
        run() {},
      }),
    };
    const md = generateCommandsMd(subCommands);
    expect(md).toContain('## Other');
    expect(md).toContain('### `monoceros odd`');
  });

  it('marks optional positionals with [brackets] and required ones with <angles>', () => {
    const subCommands = {
      restore: defineCommand({
        meta: { name: 'restore', group: 'lifecycle', description: '' },
        args: {
          'backup-path': { type: 'positional', required: false },
        },
        run() {},
      }),
    };
    const md = generateCommandsMd(subCommands);
    expect(md).toContain('### `monoceros restore [backup-path]`');
  });

  it('renders flag value placeholders by type', () => {
    const subCommands = {
      tunnel: defineCommand({
        meta: { name: 'tunnel', group: 'tooling', description: '' },
        args: {
          'local-port': { type: 'string', description: 'Host port.' },
          verbose: { type: 'boolean', description: 'Verbose output.' },
        },
        run() {},
      }),
    };
    const md = generateCommandsMd(subCommands);
    expect(md).toContain('- `--local-port` <value> — Host port.');
    expect(md).toContain('- `--verbose` — Verbose output.');
  });
});
