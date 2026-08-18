import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runShare, parseForwardPorts } from '../share/run.js';

export const shareCommand = defineCommand({
  meta: {
    name: 'share',
    group: 'discovery',
    description:
      "Expose an app's ports and the workbench's HTTP services to the local network (phone, tablet, other devices) over HTTPS so any device can open them - reached via the host's LAN IP (or `.local` name). TLS is served with a machine-local CA; trust the printed rootCA.pem once per device for warning-free HTTPS (and a working PWA secure context). Shared are every target in the app's launch.json that declares a port, plus every service with an `httpPort` in the yml. Foreground: Ctrl+C stops sharing.",
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
        'App to share (a path under projects/ with .monoceros/launch.json). Every target with a `port` is exposed on the LAN. Without a launch config it warns and shares the services alone.',
      required: true,
    },
    'forward-ports': {
      type: 'string',
      description:
        'Publish busy container ports under different host ports. Docker `-p` order (host:container), comma-separated: --forward-ports 15173:5173,18000:8000. A service can be named explicitly (18080:keycloak:8080), which an ambiguous bare port asks for. Use when an IDE already forwards the port to localhost. Unlisted ports keep parity.',
      required: false,
    },
  },
  async run({ args }) {
    try {
      const forwardPorts = args['forward-ports']
        ? parseForwardPorts(String(args['forward-ports']))
        : undefined;
      const exitCode = await runShare({
        name: args.name,
        app: args.app,
        ...(forwardPorts ? { forwardPorts } : {}),
      });
      process.exit(exitCode);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
