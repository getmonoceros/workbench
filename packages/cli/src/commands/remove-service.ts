import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveService } from '../modify/index.js';

export const removeServiceCommand = defineCommand({
  meta: {
    name: 'remove-service',
    description:
      'Remove a compose service from the container config. Idempotent, prints a diff before writing. Note: data volumes (e.g. postgres-data) are NOT cleaned up automatically.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    service: {
      type: 'positional',
      description: 'Service identifier (e.g. postgres, redis).',
      required: true,
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
        name: args.name,
        service: args.service,
        yes: args.yes,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
