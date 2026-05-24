import { defineCommand } from 'citty';
import { consola } from 'consola';
import { readConfig } from '../config/io.js';
import { containerConfigPath, containerDir } from '../config/paths.js';
import { runStart } from '../devcontainer/compose.js';
import { ensureProxy } from '../proxy/index.js';
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
      // container up when the yml declares ports. Safe to call when
      // the proxy is already up (idempotent) and a no-op when no
      // yml exists (start would have failed anyway). See ADR 0007.
      try {
        const parsed = await readConfig(containerConfigPath(args.name));
        if (parsed.config.ports.length > 0) {
          await ensureProxy();
        }
      } catch (err) {
        consola.warn(
          `Could not pre-flight Traefik proxy: ${err instanceof Error ? err.message : String(err)}. Continuing.`,
        );
      }
      return runStart({ root: containerDir(args.name) });
    });
  },
});
