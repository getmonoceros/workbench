import { createServer } from 'node:net';
import {
  PROXY_CONTAINER_NAME,
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
 *   2. Otherwise, try to bind the port via Node's net.createServer
 *      and immediately release. Bind success ⇒ free. EADDRINUSE ⇒
 *      held by something we don't control; throw a clear error.
 *
 * The bind probe is plumbed through `PortProbe` so tests can inject
 * a stub.
 */

export type PortProbe = (port: number) => Promise<PortProbeResult>;

export type PortProbeResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

const realPortProbe: PortProbe = (port) => {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (err: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        code: err.code ?? 'UNKNOWN',
        message: err.message,
      });
    });
    server.once('listening', () => {
      server.close(() => resolve({ ok: true }));
    });
    // Bind on 0.0.0.0 — same address Docker's -p mapping reserves.
    // Binding only on 127.0.0.1 wouldn't catch the case where another
    // process holds the same port via 0.0.0.0.
    server.listen(port, '0.0.0.0');
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
  if (opts.docker) {
    const inspect = await opts.docker([
      'inspect',
      '--format',
      '{{.State.Running}}',
      PROXY_CONTAINER_NAME,
    ]);
    if (inspect.exitCode === 0 && inspect.stdout.trim() === 'true') {
      return;
    }
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
    lines.push(`Cannot bind host port ${hostPort}: ${systemMessage}`);
    lines.push('');
    if (code === 'EACCES') {
      lines.push(`Port ${hostPort} is a privileged port (<1024) and your`);
      lines.push(`current Docker setup can't bind it. For rootful Docker`);
      lines.push(`(what Monoceros requires) this should normally work —`);
      lines.push(`check that the docker daemon is running as root.`);
      lines.push('');
    }
    lines.push('You can also move Monoceros off this port by setting');
    lines.push('`routing.hostPort` in ~/.monoceros/monoceros-config.yml.');
    lines.push('');
    lines.push(`Aborting — re-run after the issue is resolved.`);
  }
  return lines.join('\n');
}
