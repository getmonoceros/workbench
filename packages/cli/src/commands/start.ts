import { defineCommand } from 'citty';
import { consola } from 'consola';
import { readMachineSettings } from '../config/global.js';
import { readConfig } from '../config/io.js';
import { containerConfigPath, containerDir } from '../config/paths.js';
import { spawnBridgeDaemon } from '../devcontainer/bridge-daemon.js';
import {
  collectOutput,
  composeProjectName,
  isComposeMode,
  runStart,
  startDeferredServices,
} from '../devcontainer/compose.js';
import {
  runtimeSupportsAppRestart,
  runtimeSupportsBrowserBridge,
  serviceDefersStart,
} from '../create/catalog.js';
import { OPEN_TOOLS, runOpen } from '../open/index.js';
import { attachWorkbenchToProxy, ensureProxy } from '../proxy/index.js';
import { httpServices } from '../config/http-services.js';
import { preflightHostPort } from '../proxy/port-check.js';
import {
  ctlArgs,
  findRunningContainer,
  hasWantedApps,
  runAppCtl,
} from '../devcontainer/app-control.js';
import { dim } from '../util/format.js';
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
    // 80 (or the configured `MONOCEROS_HOST_PORT`) is held by
    // somebody else; ensureProxy itself is idempotent and safe to
    // call when the proxy is already up. See ADR 0007.
    let needsProxy = false;
    let hostPort = 80;
    let hasPorts = false;
    let exposed: string[] = [];
    // Services deferred out of the initial `devcontainer up` (ADR 0025),
    // resolved by catalog name from the yml. Brought up in a second wave
    // after `runStart` so a service bind-mounting a cloned repo file finds
    // it present at boot.
    let deferred: string[] = [];
    let runtimeVersion: string | undefined;
    try {
      const parsed = await readConfig(containerConfigPath(args.name));
      runtimeVersion = parsed.config.runtimeVersion;
      // Ports and exposed services both need the singleton: a workbench whose
      // reverse proxy answers at `<name>-caddy.localhost` declares no
      // `routing.ports` at all, and starting it without Traefik would leave
      // that address dead.
      hasPorts = (parsed.config.routing?.ports ?? []).length > 0;
      exposed = httpServices(parsed.config.services).map((s) => s.name);
      const hasRoutes = hasPorts || exposed.length > 0;
      if (hasRoutes) {
        needsProxy = true;
        ({ hostPort } = await readMachineSettings({
          notify: (m) => consola.warn(m),
        }));
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
    // Buffer the raw `devcontainer up` banner/JSON (quiet) and drop the
    // "Bringing devcontainer up…" line (no-op logger); on success we print a
    // clean status line instead. `quiet` (not `silent`) is deliberate: on a
    // non-zero exit it flushes the buffered output to stderr, so a failed
    // start shows the actual devcontainer error instead of exiting mute.
    const exitCode = await runStart({
      root: containerDir(args.name),
      quiet: true,
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
      // Keep compose's own Creating/Starting/Started lines off the screen, as
      // for `devcontainer up` above; they are shown only when the wave fails,
      // because then they carry docker's reason.
      const output = collectOutput();
      try {
        const deferExit = await startDeferredServices({
          root: containerDir(args.name),
          services: deferred,
          logSink: output.sink,
          silent: true,
        });
        if (deferExit !== 0) {
          const detail = output.text();
          consola.warn(
            `Deferred service(s) ${deferred.join(', ')} did not start cleanly (exit ${deferExit}).` +
              (detail ? `\n${detail}` : ''),
          );
        }
      } catch (err) {
        consola.warn(
          `Could not start deferred service(s) ${deferred.join(', ')}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Join the routed containers to `monoceros-proxy` under their prefixed
    // aliases (#124), after the deferred wave so those are included. A no-op
    // for a container that kept its membership; needed for one compose
    // recreated, e.g. after `stop --down`. Image mode has it from its run args.
    const root = containerDir(args.name);
    if (exitCode === 0 && needsProxy && isComposeMode(root)) {
      try {
        await attachWorkbenchToProxy({
          name: args.name,
          composeProject: composeProjectName(root),
          hasPorts,
          services: exposed,
        });
      } catch (err) {
        consola.warn(
          `Could not join the proxy network, so the \`.localhost\` routes answer 502: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (exitCode === 0) {
      consola.success(`Container '${args.name}' is up.`);
      await restoreWantedApps(args.name, runtimeVersion);
    } else {
      // `quiet` mode already flushed the devcontainer output to stderr; add a
      // one-line verdict so the non-zero exit is never a silent mystery.
      consola.error(
        `Container '${args.name}' failed to start (devcontainer up exited ${exitCode}).`,
      );
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

/**
 * Bring back the apps that were running (#25, ADR 0028), after the deferred
 * services. A service may still be starting then; the runner retries a target
 * that exits too early, whichever service it waits for. Covers the fresh container a
 * `start` after `stop --down` creates, whose entrypoint skips the reconcile
 * on its first start. After a plain `stop` the entrypoint reconciles too; the
 * runner's launch lock makes the second pass report "already running".
 * Best-effort, like apply's: a failure warns and the start result stands.
 */
async function restoreWantedApps(
  name: string,
  runtimeVersion: string | undefined,
): Promise<void> {
  if (!runtimeSupportsAppRestart(runtimeVersion)) return;
  if (!(await hasWantedApps(name))) return;
  process.stdout.write(`\n  ${dim('restoring apps that were running…')}\n`);
  try {
    await runAppCtl(name, ['reconcile']);
  } catch (err) {
    consola.warn(
      `Restoring running apps skipped: ${err instanceof Error ? err.message : String(err)}. Bring them back with \`monoceros start ${name} <app>\`.`,
    );
  }
}
