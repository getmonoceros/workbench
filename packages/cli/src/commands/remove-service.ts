import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveService } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const removeServiceCommand = defineCommand({
  meta: {
    name: 'remove-service',
    description:
      'Remove a compose service from the solution config. Idempotent, prints a diff before writing. Note: data volumes (e.g. postgres-data) are NOT cleaned up automatically.',
  },
  args: {
    service: {
      type: 'positional',
      description: 'Service identifier (e.g. postgres, redis).',
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
      const result = await runRemoveService({
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
