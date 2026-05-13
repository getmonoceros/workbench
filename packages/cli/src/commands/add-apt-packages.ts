import { defineCommand } from 'citty';
import { consola } from 'consola';
import { getInnerArgs } from '../inner-args.js';
import { runAddAptPackages } from '../modify/index.js';
import { CLI_VERSION } from '../version.js';

export const addAptPackagesCommand = defineCommand({
  meta: {
    name: 'add-apt-packages',
    description:
      'Install additional Debian/Ubuntu apt packages in the devcontainer. Pass package names after `--` (e.g. `monoceros add-apt-packages -- make openssh-client jq`). Idempotent, prints a diff before writing. No curated whitelist — invalid names surface as apt errors at container build time.',
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
    // Same `--` separator as `monoceros run`: keeps citty's
    // positional-singular limitation out of the way and lets package
    // names that look like flags (e.g. `--ignore-foo` style — rare for
    // apt but plausible) pass through unmangled.
    const packages = [...getInnerArgs()];
    if (packages.length === 0) {
      consola.error(
        'No package names given. Usage: `monoceros add-apt-packages [--yes] [--project=<path>] -- <pkg> [<pkg> …]`.',
      );
      process.exit(1);
    }
    try {
      const result = await runAddAptPackages({
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
