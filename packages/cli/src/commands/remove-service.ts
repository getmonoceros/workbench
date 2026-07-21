import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runRemoveService } from '../modify/index.js';

export const removeServiceCommand = defineCommand({
  meta: {
    name: 'remove-service',
    group: 'edit',
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
  },
  async run({ args }) {
    try {
      await runRemoveService({
        name: args.name,
        service: args.service,
      });
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
