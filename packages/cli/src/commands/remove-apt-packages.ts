import { defineCommand } from 'citty';
import { consola } from 'consola';
import { getInnerArgs } from '../inner-args.js';
import { runRemoveAptPackages } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const removeAptPackagesCommand = defineCommand({
  meta: {
    name: 'remove-apt-packages',
    description:
      'Remove apt packages from the solution config. Pass package names after `--` (e.g. `monoceros remove-apt-packages -- make jq`). Idempotent, prints a diff before writing.',
  },
  args: {
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
    const packages = [...getInnerArgs()];
    if (packages.length === 0) {
      consola.error(
        'No package names given. Usage: `monoceros remove-apt-packages [--yes] [--project=<path>] -- <pkg> [<pkg> …]`.',
      );
      process.exit(1);
    }
    try {
      const result = await runRemoveAptPackages({
        packages,
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
