import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runAddService } from '../modify/index.js';

export const addServiceCommand = defineCommand({
  meta: {
    name: 'add-service',
    group: 'edit',
    description:
      'Add a backing service to the container config. A curated name (postgres, mysql, redis) expands to a full editable block; any other image (e.g. rustfs/rustfs:latest) drops in name + image plus a commented scaffold. Idempotent, prints a diff before writing.',
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
      description:
        'Curated name (postgres, mysql, redis) or any image ref (e.g. rustfs/rustfs:latest).',
      required: true,
    },
    as: {
      type: 'string',
      description:
        'Override the service name (the compose service / DNS name / data dir). Lets you add the same image more than once — e.g. two postgres servers as postgres-app and postgres-analytics.',
    },
  },
  async run({ args }) {
    try {
      await runAddService({
        name: args.name,
        service: args.service,
        ...(args.as ? { as: args.as } : {}),
      });
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
