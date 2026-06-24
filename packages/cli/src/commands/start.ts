import { defineCommand } from 'citty';
import { consola } from 'consola';
import { proxyHostPort, readMonocerosConfig } from '../config/global.js';
import { readConfig } from '../config/io.js';
import { containerConfigPath, containerDir } from '../config/paths.js';
import { spawnBridgeDaemon } from '../devcontainer/bridge-daemon.js';
import { runStart, startDeferredServices } from '../devcontainer/compose.js';
import {
  runtimeSupportsBrowserBridge,
  serviceDefersStart,
} from '../create/catalog.js';
import { OPEN_TOOLS, runOpen } from '../open/index.js';
import { ensureProxy } from '../proxy/index.js';
import { preflightHostPort } from '../proxy/port-check.js';
import {
  ctlArgs,
  findRunningContainer,
  runAppCtl,
} from '../devcontainer/app-control.js';
import { dispatch } from './_dispatch.js';

export const startCommand = defineCommand({
  meta: {
    name: 'start',
    group: 'run',
    description:
      'Bring the named dev-container up. With an <app>, start that app inside it (per its projects/<app>/.monoceros/launch.json); the container is brought up first if needed.',
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
        'App to start (a path under projects/ with .monoceros/launch.json). Omit to just bring the container up.',
      required: false,
    },
    target: {
      type: 'string',
      description:
        'Which launch target to start (defaults to the app\'s "default" target, or its only one).',
    },
    open: {
      type: 'string',
      description: `After a successful start, open the container in this tool (${OPEN_TOOLS.join('|')}).`,
    },
  },
  run({ args }) {
    // Dispatch by argument count, like `logs <name> [<app>]`: with an <app>
    // this starts a long-running server inside the container; without one it
    // is plain container lifecycle.
    if (typeof args.app === 'string' && args.app.length > 0) {
      const app = args.app;
      const target = typeof args.target === 'string' ? args.target : undefined;
      return dispatch(async () => {
        // Ensure the container is up first, then hand off to the in-container
        // runner. Bringing it up reuses the same lifecycle path below.
        if (!(await findRunningContainer(args.name))) {
          const up = await bringContainerUp(args.name, undefined);
          if (up !== 0) return up;
        }
        return runAppCtl(args.name, ctlArgs('start', app, target));
      });
    }
    return dispatch(() =>
      bringContainerUp(
        args.name,
        typeof args.open === 'string' ? args.open : undefined,
      ),
    );
  },
});

/**
 * Bring the named dev-container up (Traefik pre-flight, `devcontainer up`,
 * browser bridge, deferred services, optional `--open`). Returns the exit
 * code. Shared by the plain `start <name>` path and the auto-start that
 * precedes `start <name> <app>`.
 */
async function bringContainerUp(
  name: string,
  openTool: string | undefined,
): Promise<number> {
  {
    const args = { name, open: openTool };
    // Re-establish the Traefik singleton before bringing the
    // container up when the yml declares ports. The pre-flight
    // host-port check fails hard with an actionable hint if port
    // 80 (or the configured `routing.hostPort`) is held by
    // somebody else; ensureProxy itself is idempotent and safe to
    // call when the proxy is already up. See ADR 0007.
    let needsProxy = false;
    let hostPort = 80;
    // Services deferred out of the initial `devcontainer up` (ADR 0025),
    // resolved by catalog name from the yml. Brought up in a second wave
    // after `runStart` so a service bind-mounting a cloned repo file finds
    // it present at boot.
    let deferred: string[] = [];
    let runtimeVersion: string | undefined;
    try {
      const parsed = await readConfig(containerConfigPath(args.name));
      runtimeVersion = parsed.config.runtimeVersion;
      if ((parsed.config.routing?.ports ?? []).length > 0) {
        needsProxy = true;
        const global = await readMonocerosConfig();
        hostPort = proxyHostPort(global);
      }
      deferred = (parsed.config.services ?? [])
        .filter((s) => serviceDefersStart(s.name))
        .map((s) => s.name);
    } catch (err) {
      consola.warn(
        `Could not read container yml ahead of start: ${err instanceof Error ? err.message : String(err)}. Skipping Traefik pre-flight.`,
      );
    }
    if (needsProxy) {
      await preflightHostPort(hostPort);
      await ensureProxy({ hostPort });
    }
    // Capture the raw `devcontainer up` banner/JSON (silent) and drop the
    // "Bringing devcontainer up…" line (no-op logger); on success we print a
    // clean status line instead. A failure still surfaces the captured output.
    const exitCode = await runStart({
      root: containerDir(args.name),
      silent: true,
      logger: { info: () => {} },
    });
    // Re-establish the host-side browser bridge for this freshly-started
    // container (same gating + best-effort as apply); the previous daemon
    // self-exited when the container last stopped.
    if (exitCode === 0 && runtimeSupportsBrowserBridge(runtimeVersion)) {
      spawnBridgeDaemon(containerDir(args.name));
    }
    // Second wave (ADR 0025): start deferred services after the workspace
    // is up. Best-effort — a failure is surfaced but the start result stands.
    if (exitCode === 0 && deferred.length > 0) {
      try {
        const deferExit = await startDeferredServices({
          root: containerDir(args.name),
          services: deferred,
          logger: consola,
        });
        if (deferExit !== 0) {
          consola.warn(
            `Deferred service(s) ${deferred.join(', ')} did not start cleanly (exit ${deferExit}).`,
          );
        }
      } catch (err) {
        consola.warn(
          `Could not start deferred service(s) ${deferred.join(', ')}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (exitCode === 0) {
      consola.success(`Container '${args.name}' is up.`);
    }
    // `--open` is a convenience on top of a successful start. A failure
    // here (editor not found, etc.) must not mask the start result, so
    // it surfaces as a warning and the start's exit code stands.
    if (args.open && exitCode === 0) {
      try {
        await runOpen({ name: args.name, tool: args.open });
      } catch (err) {
        consola.warn(err instanceof Error ? err.message : String(err));
      }
    }
    return exitCode;
  }
}
