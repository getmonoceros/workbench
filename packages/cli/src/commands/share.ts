import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runShare } from '../share/run.js';

export const shareCommand = defineCommand({
  meta: {
    name: 'share',
    group: 'discovery',
    description:
      "Expose an app's ports to the local network (phone, tablet, other devices) over HTTPS so any device can open it - reached via the host's LAN IP (or `.local` name). TLS is served with a machine-local CA; trust the printed rootCA.pem once per device for warning-free HTTPS (and a working PWA secure context). Every target in the app's launch.json that declares a port is shared. Foreground: Ctrl+C stops sharing.",
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
