import { defineCommand } from 'citty';
import { consola } from 'consola';
import { getInnerArgs } from '../inner-args.js';
import { runRemoveAptPackages } from '../modify/index.js';

export const removeAptPackagesCommand = defineCommand({
  meta: {
    name: 'remove-apt-packages',
    description:
      'Remove apt packages from the container config. Pass package names after `--` (e.g. `monoceros remove-apt-packages sandbox -- make jq`). Idempotent, prints a diff before writing.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
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
    const packages = [...getInnerArgs()];
    if (packages.length === 0) {
      consola.error(
        'No package names given. Usage: `monoceros remove-apt-packages <containername> [--yes] -- <pkg> [<pkg> …]`.',
      );
      process.exit(1);
    }
    try {
      const result = await runRemoveAptPackages({
        name: args.name,
        packages,
        yes: args.yes,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
