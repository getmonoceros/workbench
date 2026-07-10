import { defineCommand } from 'citty';
import { consola } from 'consola';
import { runTunnel } from '../tunnel/run.js';

export const tunnelCommand = defineCommand({
  meta: {
    name: 'tunnel',
    group: 'discovery',
    description:
      'Open a TCP tunnel from the host to a service or port inside the container. Foreground process — Ctrl+C closes the tunnel. Pass a service name (e.g. `postgres`, `mysql`, `redis`) from the container yml or a bare in-container port number.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    target: {
      type: 'positional',
      description:
        'Service name from the container yml (e.g. `postgres`), `service:port` for an explicit in-container port (e.g. `rustfs:9001`), or a bare in-container port number → workspace (e.g. `8080`).',
      required: true,
    },
    'local-port': {
      type: 'string',
      description:
        'Host port the tunnel listens on. Default: same as the internal port (e.g. postgres → 5432). Pass a different value when the default is busy.',
    },
    'local-address': {
      type: 'string',
      description:
        'Host interface the tunnel binds to. Default: 127.0.0.1 (loopback only — same machine). Pass 0.0.0.0 to expose on all interfaces (LAN, other devices on the same network).',
    },
  },
  async run({ args }) {
    try {
      const localPort = parseLocalPort(args['local-port']);
      const exitCode = await runTunnel({
        name: args.name,
        target: args.target,
        ...(localPort !== undefined ? { localPort } : {}),
        ...(args['local-address']
          ? { localAddress: args['local-address'] }
          : {}),
      });
      process.exit(exitCode);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

function parseLocalPort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n >= 65536) {
    throw new Error(
      `Invalid --local-port '${raw}': must be an integer between 1 and 65535.`,
    );
  }
  return n;
}
