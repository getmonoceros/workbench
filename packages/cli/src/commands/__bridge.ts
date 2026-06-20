import { defineCommand } from 'citty';
import { runBridgeDaemon } from '../devcontainer/bridge-daemon.js';

/**
 * Internal, hidden command run as a DETACHED background process by
 * `spawnBridgeDaemon` (devcontainer/bridge-daemon.ts) from `apply`/`start`.
 * It is the host-side browser bridge for an attach session: it watches the
 * container's relay url-file and opens each URL on the host browser, until the
 * container stops or the process is signalled. Takes the materialized
 * container root as its only argument; never surfaces an error.
 */
export const __bridgeCommand = defineCommand({
  meta: {
    name: '__bridge',
    group: 'internal',
    hidden: true,
    description: 'Internal: host-side browser-bridge daemon (background).',
  },
  args: {
    root: {
      type: 'positional',
      description:
        'Materialized container root ($MONOCEROS_HOME/container/<name>/).',
      required: true,
    },
  },
  async run({ args }) {
    try {
      await runBridgeDaemon({ root: args.root });
    } catch {
      /* silent — background plumbing */
    }
  },
});
