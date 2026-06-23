import { defineCommand } from 'citty';
import { consola } from 'consola';
import { containerDir } from '../config/paths.js';
import { runStop } from '../devcontainer/compose.js';
import { maybeStopProxy } from '../proxy/index.js';
import { ctlArgs, runAppCtl } from '../devcontainer/app-control.js';
import { dispatch } from './_dispatch.js';

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    group: 'run',
    description:
      'Stop the compose services for the named dev-container. With an <app>, stop that long-running app inside it instead (kills its process group).',
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
        'App to stop (a path under projects/ with .monoceros/launch.json). Omit to stop the container.',
      required: false,
    },
    target: {
      type: 'string',
      description:
        'Which launch target to stop (defaults to the app\'s "default" target, or its only one).',
    },
    service: {
      type: 'string',
      description:
        'Restrict to a single compose service (e.g. postgres). Defaults to all.',
    },
  },
  run({ args }) {
    // With an <app>, stop that app via the in-container runner; without one,
    // stop the container's compose services (existing lifecycle).
    if (typeof args.app === 'string' && args.app.length > 0) {
      const app = args.app;
      const target = typeof args.target === 'string' ? args.target : undefined;
      return dispatch(() => runAppCtl(args.name, ctlArgs('stop', app, target)));
    }
    return dispatch(async () => {
      const exit = await runStop({
        root: containerDir(args.name),
        ...(typeof args.service === 'string' ? { service: args.service } : {}),
      });
      // Tear down the Traefik singleton if this was the last container
      // depending on it. Cheap idempotent call — no-ops when the proxy
      // network is already gone or other containers are still attached.
      // See ADR 0007 (variant A: stop and remove treated identically).
      try {
        await maybeStopProxy({
          logger: { info: (msg) => consola.info(msg) },
        });
      } catch (err) {
        consola.warn(
          `Could not tear down the Traefik proxy: ${err instanceof Error ? err.message : String(err)}. Ignored.`,
        );
      }
      return exit;
    });
  },
});
