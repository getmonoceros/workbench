import { defineCommand } from 'citty';
import { consola } from 'consola';
import { getInnerArgs } from '../inner-args.js';
import { runRemoveAptPackages } from '../modify/index.js';

export const removeAptPackagesCommand = defineCommand({
  meta: {
    name: 'remove-apt-packages',
    group: 'edit',
    description:
      'Remove apt packages from the container config. Pass package names as arguments (e.g. `monoceros remove-apt-packages sandbox make jq`). Idempotent, prints a diff before writing.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    packages: {
      type: 'positional',
      description:
        'One or more apt package names to remove (e.g. `make jq`). At least one is required.',
      required: false,
    },
  },
  async run({ args }) {
    // Packages are positional (`remove-apt-packages acme make`); the `--` form
    // still works as a fallback. `args._` carries every positional including
    // the container name, so drop the first.
    const packages = [...args._.slice(1).map(String), ...getInnerArgs()];
    if (packages.length === 0) {
      consola.error(
        'No package names given. Usage: `monoceros remove-apt-packages <containername> <pkg> [<pkg> …]`.',
      );
      process.exit(1);
    }
    try {
      await runRemoveAptPackages({
        name: args.name,
        packages,
      });
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
