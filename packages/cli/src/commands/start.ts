import { defineCommand } from 'citty';
import { consola } from 'consola';
import { proxyHostPort, readMonocerosConfig } from '../config/global.js';
import { readConfig } from '../config/io.js';
import { containerConfigPath, containerDir } from '../config/paths.js';
import { runStart } from '../devcontainer/compose.js';
import { ensureProxy } from '../proxy/index.js';
import { preflightHostPort } from '../proxy/port-check.js';
import { dispatch } from './_dispatch.js';

export const startCommand = defineCommand({
  meta: {
    name: 'start',
    group: 'run',
    description:
      'Bring the named dev-container up via `devcontainer up` (workspace + runServices, postCreate, features).',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
  },
  run({ args }) {
    return dispatch(async () => {
      // Re-establish the Traefik singleton before bringing the
      // container up when the yml declares ports. The pre-flight
      // host-port check fails hard with an actionable hint if port
      // 80 (or the configured `routing.hostPort`) is held by
      // somebody else; ensureProxy itself is idempotent and safe to
      // call when the proxy is already up. See ADR 0007.
      let needsProxy = false;
      let hostPort = 80;
      try {
        const parsed = await readConfig(containerConfigPath(args.name));
        if ((parsed.config.routing?.ports ?? []).length > 0) {
          needsProxy = true;
          const global = await readMonocerosConfig();
          hostPort = proxyHostPort(global);
        }
      } catch (err) {
        consola.warn(
          `Could not read container yml ahead of start: ${err instanceof Error ? err.message : String(err)}. Skipping Traefik pre-flight.`,
        );
      }
      if (needsProxy) {
        await preflightHostPort(hostPort);
        await ensureProxy({ hostPort });
      }
      return runStart({ root: containerDir(args.name) });
    });
  },
});
