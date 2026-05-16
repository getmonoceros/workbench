import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveFromUrl } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const removeFromUrlCommand = defineCommand({
  meta: {
    name: 'remove-from-url',
    description:
      'Remove a previously-added install URL from the solution config. Idempotent, prints a diff before writing. The URL is dropped from post-create.sh on the next `monoceros apply`.',
  },
  args: {
    url: {
      type: 'positional',
      description: 'Install URL to remove (must match the original exactly).',
      required: true,
    },
    project: {
      type: 'string',
      description:
        'Override the auto-detected project (path, absolute or relative to cwd).',
    },
    yes: {
      type: 'boolean',
      description: 'Skip the interactive confirmation and apply the diff.',
      alias: ['y'],
      default: false,
    },
  },
  async run({ args }) {
    try {
      const result = await runRemoveFromUrl({
        url: args.url,
        project: typeof args.project === 'string' ? args.project : undefined,
        yes: args.yes,
        cliVersion: CLI_VERSION,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
