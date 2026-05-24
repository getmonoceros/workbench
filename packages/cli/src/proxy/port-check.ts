import { Socket } from 'node:net';
import {
  PROXY_CONTAINER_NAME,
  defaultDockerExec,
  type DockerExec,
  type ProxyLogger,
} from './index.js';

/**
 * Pre-flight check on the host port the Traefik singleton would bind.
 *
 * Why this exists: `docker run -p <port>:80` fails with a cryptic
 * `bind: address already in use` line buried inside docker's own
 * stderr, and the builder then has no idea (a) which port, (b) who's
 * holding it, (c) how to choose a different one. Catching this before
 * the docker call lets us point at the exact remedy.
 *
 * Two paths:
 *
 *   1. If the `monoceros-proxy` container is already running, the
 *      port is "in use" by us — nothing to check. Skip silently.
 *
 *   2. Otherwise, try to TCP-connect to `127.0.0.1:<port>`. Something
 *      accepting the connection ⇒ port is taken; ECONNREFUSED ⇒
 *      nobody's listening and the port is (probably) free for Docker.
 *
 * We deliberately do NOT try to bind the port ourselves. On Linux,
 * binding ports <1024 requires CAP_NET_BIND_SERVICE — which the
 * unprivileged Node process running monoceros doesn't have, even when
 * the docker daemon does. The bind probe would EACCES with our own
 * lack of privilege, not with someone actually holding the port. The
 * connect probe sidesteps that: connects don't need a privileged port.
 *
 * Trade-off: connect catches anything that's actively LISTEN'ing on
 * 127.0.0.1 or 0.0.0.0 (system nginx, Pi-hole, …) — the cases that
 * realistically conflict with Docker's `-p 80:80`. If something binds
 * only on a specific external interface (192.168.x.x:80) and refuses
 * loopback, the connect probe sees ECONNREFUSED and lets Docker
 * surface its own error — which then carries our actionable hint via
 * the error-message wrapping in apply/.
 *
 * The probe is plumbed through `PortProbe` so tests can inject a stub.
 */

export type PortProbe = (port: number) => Promise<PortProbeResult>;

export type PortProbeResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

const CONNECT_TIMEOUT_MS = 750;

const realPortProbe: PortProbe = (port) => {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const settle = (result: PortProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      // Something accepted our connection → the port is held.
      settle({
        ok: false,
        code: 'EADDRINUSE',
        message: `another process is listening on ${port}`,
      });
    });
    socket.once('timeout', () => {
      // No SYN-ACK within the timeout. Could be a firewalled bind or
      // a daemon not on loopback; treat as "probably free" and let
      // Docker speak up if it disagrees.
      settle({ ok: true });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'UNKNOWN';
      if (code === 'ECONNREFUSED') {
        // Nobody listening — the typical "port is free" signal.
        settle({ ok: true });
      } else {
        // Other errors (EHOSTUNREACH, ENETDOWN, …) aren't our bind
        // story. Don't pretend we know — surface verbatim so the
        // builder sees what their network is doing.
        settle({
          ok: false,
          code,
          message: err.message,
        });
      }
    });
    socket.connect(port, '127.0.0.1');
  });
};

export interface PreflightHostPortOptions {
  /**
   * Override the docker exec used to check whether monoceros-proxy is
   * already running. Tests inject a fake.
   */
  docker?: DockerExec;
  /** Override the bind probe. Tests inject a fake. */
  portProbe?: PortProbe;
  logger?: ProxyLogger;
}

/**
 * Ensure `hostPort` is bindable, OR explain in detail why it isn't.
 *
 * - Returns silently when the port is bindable (or already held by
 *   the monoceros-proxy container).
 * - Throws an Error with a formatted, actionable message otherwise.
 *
 * The caller (apply / start / add-port hot-path) is expected to
 * `try { await preflightHostPort(...) } catch { print + exit }` —
 * i.e. abort the command cleanly with the rendered hint, not let
 * the docker `bind: address already in use` slip through.
 */
export async function preflightHostPort(
  hostPort: number,
  opts: PreflightHostPortOptions = {},
): Promise<void> {
  // Is monoceros-proxy itself the current holder? If so, ensureProxy
  // will be a no-op and the port-check has nothing to tell us.
  // ALWAYS run this check (not just when opts.docker is overridden) —
  // otherwise the bind probe would fail on Traefik's own port and
  // the builder would see "port 80 held by another process" pointing
  // at our own running container.
  const docker = opts.docker ?? defaultDockerExec;
  const inspect = await docker([
    'inspect',
    '--format',
    '{{.State.Running}}',
    PROXY_CONTAINER_NAME,
  ]);
  if (inspect.exitCode === 0 && inspect.stdout.trim() === 'true') {
    return;
  }

  const probe = opts.portProbe ?? realPortProbe;
  const result = await probe(hostPort);
  if (result.ok) return;

  // EADDRINUSE is the case we want to dress up nicely. Anything else
  // (EACCES on Linux without CAP_NET_BIND_SERVICE for unprivileged
  // ports < 1024, etc.) gets the message verbatim but framed the
  // same way — the remedy is the same: pick a different port.
  throw new Error(
    formatHostPortHeldError(hostPort, result.code, result.message),
  );
}

export function formatHostPortHeldError(
  hostPort: number,
  code: string,
  systemMessage: string,
): string {
  const isInUse = code === 'EADDRINUSE';
  const lines: string[] = [];
  if (isInUse) {
    lines.push(`Host port ${hostPort} is already in use by another process.`);
    lines.push('');
    lines.push(`Monoceros needs that port for its Traefik proxy (the thing`);
    lines.push(`that routes <name>.localhost / <name>-<port>.localhost to`);
    lines.push(`your dev-container). Two ways out:`);
    lines.push('');
    lines.push('  1) Recommended: free the port.');
    lines.push('     Identify the process holding it:');
    lines.push(`        sudo lsof -iTCP:${hostPort} -sTCP:LISTEN -n -P`);
    lines.push(`        # or:   sudo ss -tlnp | grep ":${hostPort}\\b"`);
    lines.push('     Then stop or reconfigure that service.');
    lines.push('');
    lines.push('  2) Move Monoceros off port 80. Edit (or create)');
    lines.push('     ~/.monoceros/monoceros-config.yml and add:');
    lines.push('');
    lines.push('        schemaVersion: 1');
    lines.push('        routing:');
    lines.push('          hostPort: 8080      # any free port');
    lines.push('');
    lines.push('     URLs will become http://<name>.localhost:8080/.');
    lines.push('');
    lines.push(`Aborting — re-run after the conflict is resolved.`);
  } else {
    lines.push(`Cannot reach host port ${hostPort}: ${systemMessage}`);
    lines.push('');
    lines.push(`This is not the typical "port already in use" case —`);
    lines.push(`Monoceros's pre-flight uses a TCP-connect probe (not a`);
    lines.push(`bind), so EACCES / privileged-port errors normally don't`);
    lines.push(`appear here. Most likely something on your host network`);
    lines.push(`stack (firewall, network namespace, …) is interfering with`);
    lines.push(`loopback connects.`);
    lines.push('');
    lines.push('Workaround: move Monoceros off this port by setting');
    lines.push('`routing.hostPort` in ~/.monoceros/monoceros-config.yml.');
    lines.push('');
    lines.push(`Aborting — re-run after the issue is resolved.`);
  }
  return lines.join('\n');
}
