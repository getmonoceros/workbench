import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runCreateVersion } from '../catalog/create-version.js';

export const createVersionCommand = defineCommand({
  meta: {
    name: 'create-version',
    group: 'templates',
    description:
      'Start a new version of one of your own services in ~/.monoceros/templates/services/: keeps the current <service>.yml as <service>@<n>.yml and raises the version in <service>.yml, ready for your change. Workbenches built from the old version keep it until `monoceros upgrade`.',
  },
  args: {
    service: {
      type: 'positional',
      description:
        'One of your own services, by its file name in ~/.monoceros/templates/services/ (e.g. rabbitmq).',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const result = await runCreateVersion({ service: args.service });
      consola.success(`Kept version ${result.version - 1} as ${result.kept}`);
      consola.success(
        `${result.current} is now version ${result.version}: make your change there.`,
      );
      consola.info('In a team repository, commit both files there.');
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
