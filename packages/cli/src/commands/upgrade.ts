import { defineCommand } from 'citty';
import { runUpgrade } from '../upgrade/index.js';
import { CLI_VERSION } from '../version.js';
import { dispatch } from './_dispatch.js';

/**
 * `monoceros upgrade <name> [version]` — change a container's pinned
 * runtime image version and re-apply. The pin lives in the yml and is
 * never bumped by routine `apply` (ADR 0017); this is the deliberate
 * opt-in path. `--list` shows the available versions.
 */
export const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    group: 'lifecycle',
    description:
      'Pin a container to a newer runtime image version and re-apply. `monoceros upgrade <name>` pins to the latest published version; `monoceros upgrade <name> <version>` pins to an exact one; `monoceros upgrade --list` lists available versions.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Config name. Resolves to $MONOCEROS_HOME/container-configs/<name>.yml.',
      required: false,
    },
    version: {
      type: 'positional',
      description:
        'Exact runtime version to pin (e.g. 1.1.0). Omit to use the latest published version.',
      required: false,
    },
    list: {
      type: 'boolean',
      description:
        'List available runtime versions and exit, changing nothing.',
      default: false,
    },
  },
  run({ args }) {
    return dispatch(() =>
      runUpgrade({
        ...(args.name ? { name: args.name } : {}),
        ...(args.version ? { version: args.version } : {}),
        list: args.list,
        cliVersion: CLI_VERSION,
      }),
    );
  },
});
