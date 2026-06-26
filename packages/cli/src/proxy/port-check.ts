import { Socket } from 'node:net';
import {
  PROXY_CONTAINER_NAME,
  defaultDockerExec,
  type DockerExec,
  type ProxyLogger,
} from './index.js';
import { cyan, dim } from '../util/format.js';

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

  // Non-EADDRINUSE (EACCES on a privileged port without
  // CAP_NET_BIND_SERVICE, EHOSTUNREACH, …): we can't attribute a
  // holder, so frame it generically and point at the hostPort escape.
  if (result.code !== 'EADDRINUSE') {
    throw new Error(
      formatHostPortHeldError(hostPort, result.code, result.message),
    );
  }

  // The port is held. Attribute the holder via docker so the remedy is
  // precise instead of a blind "free the port". Two distinguishable
  // cases, plus the orphan/foreign fallback:
  //   - a live container publishes it  → name it, tell them to stop it;
  //   - nothing publishes it           → leftover docker-proxy / foreign
  //     process (the WSL native-dockerd orphan), or a holder in another
  //     engine docker can't see → recommend a daemon restart + the 8080
  //     fallback.
  const live = await containersPublishing(docker, hostPort);
  if (live.length > 0) {
    throw new Error(formatLiveContainerError(hostPort, live));
  }
  throw new Error(formatLeftoverHolderError(hostPort));
}

/**
 * Names of running containers that publish `hostPort` in the active
 * docker engine. Empty when none match, when docker errors, or when the
 * holder lives in a different engine/context (docker ps is engine-scoped)
 * — all of which route to the leftover/foreign message.
 */
async function containersPublishing(
  docker: DockerExec,
  hostPort: number,
): Promise<string[]> {
  const ps = await docker([
    'ps',
    '--filter',
    `publish=${hostPort}`,
    '--format',
    '{{.Names}} ({{.Image}})',
  ]);
  if (ps.exitCode !== 0) return [];
  return ps.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Shared tail for both EADDRINUSE messages: the "move Monoceros off the
 * port" config snippet, then the abort line. Kept in one place so the
 * two formatters stay identical where they overlap.
 */
function hostPortFallbackLines(hostPort: number): string[] {
  return [
    dim('Or set a different proxy port in ') +
      cyan('~/.monoceros/monoceros-config.yml') +
      dim(':'),
    '    ' + cyan('schemaVersion: 1'),
    '    ' + cyan('routing:'),
    '    ' + cyan('  hostPort: 8080'),
    '',
    dim(
      `Aborting. Re-run once port ${hostPort} is free or a different port is set.`,
    ),
  ];
}

/** A running container in this engine publishes the port. */
export function formatLiveContainerError(
  hostPort: number,
  containers: string[],
): string {
  const firstName = containers[0]!.split(' ')[0];
  return [
    `Host port ${hostPort} is in use: it is published by a running container.`,
    '',
    dim('Held by:'),
    ...containers.map((c) => '    ' + cyan(c)),
    '',
    dim('Stop or re-map it, then re-run:'),
    '    ' + cyan(`docker stop ${firstName}`),
    '',
    ...hostPortFallbackLines(hostPort),
  ].join('\n');
}

/**
 * The port is held, but no container in the active engine publishes it.
 * Overwhelmingly a leftover docker-proxy whose container is gone (native
 * dockerd-via-systemd in WSL gets restarted often and strands these), or
 * a holder in a docker engine this CLI isn't talking to. We can't name
 * the original container (the record is gone), so we name the class and
 * the fix.
 */
export function formatLeftoverHolderError(hostPort: number): string {
  return [
    `Host port ${hostPort} is in use, but no running container publishes it.`,
    '',
    dim('Most likely a leftover docker-proxy whose container is already gone'),
    dim('(a native dockerd in WSL strands these on restart), or a holder in'),
    dim('another Docker engine. Fix it one of two ways, then re-run:'),
    '',
    dim('Reap the leftover by restarting the Docker daemon (harmless):'),
    '    ' + cyan('sudo systemctl restart docker'),
    '',
    ...hostPortFallbackLines(hostPort),
  ].join('\n');
}

/**
 * Generic framing for a probe failure we can't attribute to a holder —
 * i.e. a non-EADDRINUSE code (EACCES on a privileged port, EHOSTUNREACH,
 * a firewalled loopback, …). The EADDRINUSE case is handled by the
 * classified formatters above (live container vs leftover/foreign).
 */
export function formatHostPortHeldError(
  hostPort: number,
  _code: string,
  systemMessage: string,
): string {
  return [
    `Cannot reach host port ${hostPort}: ${systemMessage}`,
    '',
    dim('This is not the typical "port already in use" case. The pre-flight'),
    dim('uses a TCP-connect probe (not a bind), so EACCES / privileged-port'),
    dim('errors normally do not appear here. Most likely something on your'),
    dim('host network stack (firewall, network namespace) is interfering with'),
    dim('loopback connects.'),
    '',
    dim('Workaround: move Monoceros off this port by setting ') +
      cyan('routing.hostPort') +
      dim(' in ') +
      cyan('~/.monoceros/monoceros-config.yml') +
      dim('.'),
    '',
    dim('Aborting. Re-run after the issue is resolved.'),
  ].join('\n');
}
