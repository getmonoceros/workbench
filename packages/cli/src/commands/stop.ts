import { defineCommand } from 'citty';
import { consola } from 'consola';
import { containerDir } from '../config/paths.js';
import { runStop } from '../devcontainer/compose.js';
import { maybeStopProxy } from '../proxy/index.js';
import { dispatch } from './_dispatch.js';

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    group: 'run',
    description:
      'Stop the compose services for the named dev-container. Volumes are preserved.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    service: {
      type: 'string',
      description:
        'Restrict to a single compose service (e.g. postgres). Defaults to all.',
    },
  },
  run({ args }) {
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
