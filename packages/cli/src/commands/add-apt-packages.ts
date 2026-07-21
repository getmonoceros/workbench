import { defineCommand } from 'citty';
import { consola } from 'consola';
import { getInnerArgs } from '../inner-args.js';
import { runAddAptPackages } from '../modify/index.js';

export const addAptPackagesCommand = defineCommand({
  meta: {
    name: 'add-apt-packages',
    group: 'edit',
    description:
      'Add Debian/Ubuntu apt packages to the container config. Pass package names as arguments (e.g. `monoceros add-apt-packages sandbox make openssh-client jq`). Idempotent. No curated whitelist — invalid names surface as apt errors at container build time.',
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
        'One or more Debian/Ubuntu apt package names (e.g. `make jq`). At least one is required.',
      required: false,
    },
  },
  async run({ args }) {
    // Packages are positional (`add-apt-packages acme make jq`); the `--` form
    // still works as a fallback. `args._` carries every positional including
    // the container name, so drop the first.
    const packages = [...args._.slice(1).map(String), ...getInnerArgs()];
    if (packages.length === 0) {
      consola.error(
        'No package names given. Usage: `monoceros add-apt-packages <containername> <pkg> [<pkg> …]`.',
      );
      process.exit(1);
    }
    try {
      await runAddAptPackages({
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
