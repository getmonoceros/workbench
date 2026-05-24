import { defineCommand } from 'citty';
import { consola } from 'consola';
import { proxyHostPort, readMonocerosConfig } from '../config/global.js';
import { readConfig } from '../config/io.js';
import { containerConfigPath } from '../config/paths.js';
import { portNumber } from '../config/schema.js';
import { proxyUrlsFor } from '../proxy/dynamic.js';
import { colorsFor } from '../util/format.js';

export interface RunPortListingOptions {
  name: string;
  /** Override the resolved MONOCEROS_HOME (tests inject a tmpdir). */
  monocerosHome?: string;
  /** Where the table is printed. Defaults to process.stdout. */
  out?: NodeJS.WriteStream;
  /** Where the "no ports declared" hint goes. Defaults to consola. */
  info?: (message: string) => void;
}

/**
 * Render the port-listing table for one container. Pure I/O — no
 * `process.exit`, returns the intended exit code so the CLI wrapper
 * can stay thin.
 *
 *   0 → printed the table or the "no ports declared" hint
 *   1 → unrecoverable failure (yml missing, parse error, …)
 */
export async function runPortListing(
  opts: RunPortListingOptions,
): Promise<number> {
  const out = opts.out ?? process.stdout;
  const info = opts.info ?? ((m) => consola.info(m));

  const parsed = await readConfig(
    containerConfigPath(opts.name, opts.monocerosHome),
  );
  const portEntries = parsed.config.routing?.ports ?? [];
  if (portEntries.length === 0) {
    info(
      `No ports declared in ${opts.name}.yml. Run \`monoceros add-port ${opts.name} -- <port>\` to expose one.`,
    );
    return 0;
  }
  const ports = portEntries.map(portNumber);
  const globalConfig = await readMonocerosConfig({
    ...(opts.monocerosHome ? { monocerosHome: opts.monocerosHome } : {}),
  });
  const hostPort = proxyHostPort(globalConfig);
  const urls = proxyUrlsFor(opts.name, ports, hostPort);

  const isTty = out.isTTY ?? false;
  const fmt = colorsFor(out);

  // The first port doubles as the default `<name>.localhost` route.
  // Emit that as an explicit extra row so the builder sees both URLs
  // alongside the explicit port mapping for the first entry.
  const portSuffix = hostPort === 80 ? '' : `:${hostPort}`;
  const rows: Array<{ port: number; url: string; tag: string }> = [];
  rows.push({
    port: urls[0]!.port,
    url: `http://${opts.name}.localhost${portSuffix}`,
    tag: 'default',
  });
  for (const u of urls) {
    rows.push({ port: u.port, url: u.url, tag: '' });
  }

  if (!isTty) {
    for (const r of rows) {
      out.write(`${r.port}\t${r.url}\t${r.tag}\n`);
    }
    return 0;
  }

  // TTY: aligned three-column table, port cyan, url default, tag dim.
  const portWidth = Math.max(...rows.map((r) => String(r.port).length));
  const urlWidth = Math.max(...rows.map((r) => r.url.length));
  const gutter = 2;
  for (const r of rows) {
    const portStr = String(r.port).padStart(portWidth);
    const urlPad = ' '.repeat(urlWidth - r.url.length + gutter);
    const tag = r.tag ? fmt.dim(`(${r.tag})`) : '';
    out.write(`  ${fmt.cyan(portStr)}  →  ${r.url}${urlPad}${tag}\n`);
  }
  return 0;
}

export const portCommand = defineCommand({
  meta: {
    name: 'port',
    group: 'discovery',
    description:
      'List the Traefik URLs for a container. Reads ports from `routing.ports` in the container yml and the host port from `routing.hostPort` in monoceros-config.yml (default 80). When piped, drops formatting and emits `port<TAB>url<TAB>tag` per line for grep/awk consumption.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
  },
  async run({ args }) {
    try {
      const code = await runPortListing({ name: args.name });
      process.exit(code);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
