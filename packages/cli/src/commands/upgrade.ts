import { defineCommand } from 'citty';
import { runUpgrade } from '../upgrade/index.js';
import { CLI_VERSION } from '../version.js';
import { dispatch } from './_dispatch.js';

/**
 * `monoceros upgrade [name] [version]` — refresh tooling (ADR 0018) and,
 * for the base image, bump the pinned runtime when newer (ADR 0017).
 * Routine `apply` never refreshes; this is the deliberate opt-in path. It
 * rebuilds feature layers from scratch so tools re-pull latest, prunes stale
 * Monoceros-built images, and records the run so `apply` stops nudging.
 *
 *   monoceros upgrade            → refresh ALL containers + prune
 *   monoceros upgrade <name>     → refresh one container (base → latest)
 *   monoceros upgrade <name> <v> → refresh one container, pin base to <v>
 *   monoceros upgrade --list     → list available runtime versions
 */
export const upgradeCommand = defineCommand({
  meta: {
    name: 'upgrade',
    group: 'lifecycle',
    description:
      'Refresh tooling to the latest (rebuilds feature layers, bumps the runtime base when newer) and prune stale Monoceros images. `monoceros upgrade` refreshes all containers; `monoceros upgrade <name>` one; `monoceros upgrade <name> <version>` pins that base version; `monoceros upgrade --list` lists runtime versions.',
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
