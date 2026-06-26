import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runShare } from '../share/run.js';

export const shareCommand = defineCommand({
  meta: {
    name: 'share',
    group: 'discovery',
    description:
      "Expose an app's ports to the local network (phone, tablet, other devices) so any device can open it - reached via the host's LAN IP (or `.local` name). Every target in the app's launch.json that declares a port is shared. Foreground: Ctrl+C stops sharing. See ADR 0030.",
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    app: {
      type: 'positional',
      description:
        'App to share (a path under projects/ with .monoceros/launch.json). Every target with a `port` is exposed on the LAN.',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const exitCode = await runShare({ name: args.name, app: args.app });
      process.exit(exitCode);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
