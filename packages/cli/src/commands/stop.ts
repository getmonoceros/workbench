import { defineCommand } from 'citty';
import { consola } from 'consola';
import { containerDir } from '../config/paths.js';
import {
  collectOutput,
  runDown,
  runStop,
  spawnDockerComposeTo,
} from '../devcontainer/compose.js';
import { maybeStopProxy } from '../proxy/index.js';
import { ctlArgs, runAppCtl } from '../devcontainer/app-control.js';
import { dispatch } from './_dispatch.js';

/**
 * `--down` works on the whole project (#114): it can't be narrowed to an
 * app or a single service. Returns the error to show, or undefined.
 */
export function downConflict(
  name: string,
  app: string | undefined,
  service: string | undefined,
): string | undefined {
  if (app) {
    return `--down removes every container of '${name}', so it can't be limited to an app. Run 'monoceros stop ${name} ${app}' to stop the app.`;
  }
  if (service) {
    return `--down removes every container of '${name}', so it can't be limited to one service. Run 'monoceros stop ${name} --service ${service}' to stop just that service.`;
  }
  return undefined;
}

export const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    group: 'run',
    description:
      'Stop the compose services for the named dev-container. With --down, also remove its containers and network (like `docker compose down`); `start` brings it back. With an <app>, stop that long-running app inside it instead (kills its process group).',
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
    down: {
      type: 'boolean',
      description:
        'Also remove the containers and the network, like `docker compose down`. The yml, the container directory and the volumes stay; `start` recreates the containers.',
    },
  },
  run({ args }) {
    if (args.down === true) {
      const conflict = downConflict(
        args.name,
        typeof args.app === 'string' ? args.app : undefined,
        typeof args.service === 'string' ? args.service : undefined,
      );
      if (conflict) {
        return dispatch(async () => {
          throw new Error(conflict);
        });
      }
    }
    // With an <app>, stop that app via the in-container runner; without one,
    // stop the container's compose services (existing lifecycle).
    if (typeof args.app === 'string' && args.app.length > 0) {
      const app = args.app;
      const target = typeof args.target === 'string' ? args.target : undefined;
      return dispatch(() => runAppCtl(args.name, ctlArgs('stop', app, target)));
    }
    return dispatch(async () => {
      const service =
        typeof args.service === 'string' ? args.service : undefined;
      let exit: number;
      if (args.down === true) {
        // Keep the `[down] …` progress lines for a failure, where they
        // carry docker's own error; on success one status line is enough.
        const lines: string[] = [];
        exit = await runDown({
          root: containerDir(args.name),
          logger: { info: (msg) => lines.push(msg) },
        });
        if (exit === 0) {
          consola.success(`Container '${args.name}' stopped and removed.`);
        } else {
          for (const line of lines) consola.error(line);
        }
      } else {
        // Drop runStop's own "Stopped 'name'." line and compose's
        // Stopping/Stopped lines; print a clean status line below instead
        // (consistent with `start`). Compose's output is shown only on a
        // failure, where it carries docker's reason.
        const output = collectOutput();
        exit = await runStop({
          root: containerDir(args.name),
          ...(service ? { service } : {}),
          spawn: spawnDockerComposeTo({ logSink: output.sink, silent: true }),
          logger: { info: () => {} },
        });
        if (exit === 0) {
          consola.success(
            service
              ? `Container '${args.name}' service '${service}' stopped.`
              : `Container '${args.name}' stopped.`,
          );
        } else if (output.text()) {
          consola.error(output.text());
        }
      }
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
