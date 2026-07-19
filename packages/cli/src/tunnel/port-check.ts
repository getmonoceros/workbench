import { Socket } from 'node:net';

/**
 * TCP-connect probe for the *local* host port the tunnel sidecar will
 * bind. Mirrors `proxy/port-check.ts` — same reasoning (bind probes
 * trip EACCES on privileged ports under unprivileged Node; connect
 * probes don't) — but stripped down: tunnels have no "already-mine"
 * skip case (every invocation is a fresh sidecar).
 *
 * Throws Error with an actionable message when something's listening
 * on `port`. The message names the port and points at `--local-port`
 * as the override.
 */

export type PortProbe = (
  port: number,
  address: string,
) => Promise<PortProbeResult>;

export type PortProbeResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

const CONNECT_TIMEOUT_MS = 750;

export const realPortProbe: PortProbe = (port, address) => {
  // For 0.0.0.0 (any-interface) bindings, probing loopback is the
  // realistic conflict surface — anything LISTEN'ing on 0.0.0.0 or
  // 127.0.0.1 will collide with our `-p 0.0.0.0:<port>:…` mapping.
  const probeHost = address === '0.0.0.0' ? '127.0.0.1' : address;
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
      settle({
        ok: false,
        code: 'EADDRINUSE',
        message: `another process is listening on ${port}`,
      });
    });
    socket.once('timeout', () => {
      settle({ ok: true });
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'UNKNOWN';
      if (code === 'ECONNREFUSED') {
        settle({ ok: true });
      } else {
        settle({ ok: false, code, message: err.message });
      }
    });
    socket.connect(port, probeHost);
  });
};

export interface PreflightLocalPortOptions {
  port: number;
  address: string;
  /** Tests inject a stub probe. */
  probe?: PortProbe;
}

export async function preflightLocalPort(
  opts: PreflightLocalPortOptions,
): Promise<void> {
  const probe = opts.probe ?? realPortProbe;
  const result = await probe(opts.port, opts.address);
  if (result.ok) return;
  throw new Error(formatLocalPortHeldError(opts.port, opts.address, result));
}

function formatLocalPortHeldError(
  port: number,
  address: string,
  result: Extract<PortProbeResult, { ok: false }>,
): string {
  const lines: string[] = [];
  if (result.code === 'EADDRINUSE') {
    lines.push(`Local port ${port} on ${address} is already in use.`);
    lines.push('');
    lines.push('Identify the holder, then either stop it or pick a different');
    lines.push('port for the tunnel:');
    lines.push('');
    lines.push(`  sudo lsof -iTCP:${port} -sTCP:LISTEN -n -P`);
    lines.push(`  # or:   sudo ss -tlnp | grep ":${port}\\b"`);
    lines.push('');
    lines.push('Re-run with an explicit local port:');
    lines.push(`  monoceros tunnel … --local-port=${port + 1}`);
  } else {
    lines.push(
      `Cannot probe local port ${port} on ${address}: ${result.message}`,
    );
    lines.push('');
    lines.push(
      'Most likely the host network stack (firewall, namespace) is interfering.',
    );
    lines.push('Try a different local port via `--local-port=<n>`.');
  }
  return lines.join('\n');
}
