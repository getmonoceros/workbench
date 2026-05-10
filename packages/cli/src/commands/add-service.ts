import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runAddService } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const addServiceCommand = defineCommand({
  meta: {
    name: 'add-service',
    description:
      'Add a compose service (e.g. postgres, redis) to an existing solution. Idempotent, prints a diff before writing.',
  },
  args: {
    service: {
      type: 'positional',
      description: 'Service identifier from the snippet whitelist.',
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
      const result = await runAddService({
        service: args.service,
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
