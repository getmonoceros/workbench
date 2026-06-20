import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  promises as fsp,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { relayDir, relayUrlFile, watchRelayUrl } from './browser-bridge.js';
import { spawnDevcontainer, type DevcontainerSpawn } from './cli.js';
import { isWorkspaceRunning, spawnDocker, type DockerExec } from './compose.js';

/**
 * Host-side browser-bridge daemon (ADR 0022 follow-up).
 *
 * The per-session bridge (`startBrowserBridge`, wired into `monoceros
 * run`/`shell`) only relays browser-opens while that interactive command
 * runs. Sessions Monoceros does NOT spawn — an IDE / desktop-app SSH attach,
 * a Dev-Containers terminal — never get it, so a tool inside that opens a URL
 * has nowhere to send it. This daemon closes that gap: a detached host process
 * runs the SAME relay watcher (`watchRelayUrl`) for the container's whole
 * lifetime, so the always-on relay `xdg-open` shipped in the runtime image
 * (>= 1.3.3, on PATH + `$BROWSER`) reaches the host browser from any session.
 *
 * Lifecycle: spawned detached by `apply`/`start` once the container is up,
 * self-exits when the container stops (it polls `isWorkspaceRunning`), and is
 * SIGTERM'd by `remove`. A pid file under the relay dir makes the spawn
 * idempotent and gives `remove` a handle to stop it.
 */

/** PID file for a container's bridge daemon, under its relay dir. */
export function bridgePidFile(root: string): string {
  return path.join(relayDir(root), 'daemon.pid');
}

/** Whether a process with this pid is currently alive (signal-0 probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The live bridge-daemon pid for this container, or null when none runs. */
export function runningBridgePid(root: string): number | null {
  const file = bridgePidFile(root);
  if (!existsSync(file)) return null;
  let pid = NaN;
  try {
    pid = Number(readFileSync(file, 'utf8').trim());
  } catch {
    return null;
  }
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
}

/**
 * Fire-and-forget the detached bridge daemon for a container root.
 * Idempotent — a no-op when one is already alive. Best-effort: any failure is
 * swallowed, since an absent bridge only degrades browser-open and must never
 * break `apply`/`start`.
 */
export function spawnBridgeDaemon(root: string): void {
  try {
    if (runningBridgePid(root) !== null) return;
    const self = process.argv[1];
    if (!self) return;
    mkdirSync(relayDir(root), { recursive: true });
    const child = spawn(process.execPath, [self, '__bridge', root], {
      detached: true,
      stdio: 'ignore',
    });
    // Record the pid immediately so a near-simultaneous second spawn sees a
    // live daemon (the worker re-writes the same pid on startup). unref so the
    // foreground command can exit without waiting on the daemon.
    if (typeof child.pid === 'number') {
      try {
        writeFileSync(bridgePidFile(root), String(child.pid));
      } catch {
        /* best effort */
      }
    }
    child.unref();
  } catch {
    /* best effort */
  }
}

/** Stop a container's bridge daemon (SIGTERM) and drop its pid file. */
export async function stopBridgeDaemon(root: string): Promise<void> {
  const pid = runningBridgePid(root);
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await fsp.rm(bridgePidFile(root), { force: true });
}

/**
 * The daemon worker (run by the hidden `__bridge` command). Watches the relay
 * url-file for the container at `root` and opens each URL on the host, until
 * the container stops or the process is signalled. Cleans up its pid file on
 * exit. Resolves when the watch loop ends.
 */
export async function runBridgeDaemon(opts: {
  root: string;
  spawn?: DevcontainerSpawn;
  dockerExec?: DockerExec;
  /** Container-running poll interval (ms). Default 5000; tests shorten it. */
  lifecheckMs?: number;
}): Promise<void> {
  const { root } = opts;
  const dockerExec = opts.dockerExec ?? spawnDocker;
  const lifecheckMs = opts.lifecheckMs ?? 5000;

  await fsp.mkdir(relayDir(root), { recursive: true });
  // Drop any leftover URL from a previous session BEFORE watching - otherwise
  // the daemon would open a stale URL in the host browser the moment it starts
  // (e.g. right after `apply`/`upgrade`). Only URLs written while we watch
  // should open. Mirrors what the per-session bridge does on startup.
  await fsp.rm(relayUrlFile(root), { force: true });
  await fsp.writeFile(bridgePidFile(root), String(process.pid));

  const watcher = watchRelayUrl({
    urlFile: relayUrlFile(root),
    root,
    spawn: opts.spawn ?? spawnDevcontainer,
  });

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    const lifecheck = setInterval(() => {
      void isWorkspaceRunning(root, dockerExec)
        .then((up) => {
          if (!up) {
            clearInterval(lifecheck);
            finish();
          }
        })
        .catch(() => {
          /* transient docker hiccup — keep watching */
        });
    }, lifecheckMs);
    const onSignal = (): void => {
      clearInterval(lifecheck);
      finish();
    };
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
  });

  watcher.dispose();
  await fsp.rm(bridgePidFile(root), { force: true });
}
