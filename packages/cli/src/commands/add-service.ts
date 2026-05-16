import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runAddService } from '../modify/index.js';

export const addServiceCommand = defineCommand({
  meta: {
    name: 'add-service',
    description:
      'Add a compose service (postgres, mysql, redis, …) to the container config. Idempotent, prints a diff before writing.',
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
      description: 'Service identifier (postgres, mysql, redis).',
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
      const result = await runAddService({
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
