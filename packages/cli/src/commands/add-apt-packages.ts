import { defineCommand } from 'citty';
import { consola } from 'consola';
import { getInnerArgs } from '../inner-args.js';
import { runAddAptPackages } from '../modify/index.js';

export const addAptPackagesCommand = defineCommand({
  meta: {
    name: 'add-apt-packages',
    group: 'edit',
    description:
      'Add Debian/Ubuntu apt packages to the container config. Pass package names after `--` (e.g. `monoceros add-apt-packages sandbox -- make openssh-client jq`). Idempotent. No curated whitelist — invalid names surface as apt errors at container build time.',
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
        'No package names given. Usage: `monoceros add-apt-packages <containername> [--yes] -- <pkg> [<pkg> …]`.',
      );
      process.exit(1);
    }
    try {
      const result = await runAddAptPackages({
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
