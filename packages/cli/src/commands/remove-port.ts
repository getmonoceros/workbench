import { defineCommand } from 'citty';
import { consola } from 'consola';
import { getInnerArgs } from '../inner-args.js';
import { runRemovePort } from '../modify/index.js';

export const removePortCommand = defineCommand({
  meta: {
    name: 'remove-port',
    group: 'edit',
    description:
      'Remove one or more ports from the container config. Pass port numbers as arguments (e.g. `monoceros remove-port sandbox 3000 5173`). Idempotent — ports not present are skipped silently.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    ports: {
      type: 'positional',
      description:
        'One or more port numbers to remove (e.g. `3000 5173`). At least one is required.',
      required: false,
    },
  },
  async run({ args }) {
    // Ports are positional (`remove-port acme 3000`); the `--` form still works
    // as a fallback. `args._` carries every positional including the container
    // name, so drop the first.
    const tokens = [...args._.slice(1).map(String), ...getInnerArgs()];
    if (tokens.length === 0) {
      consola.error(
        'No ports given. Usage: `monoceros remove-port <containername> <port> [<port> …]`.',
      );
      process.exit(1);
    }
    try {
      await runRemovePort({
        name: args.name,
        ports: tokens.map(coerceToken),
      });
      process.exit(0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

function coerceToken(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : (raw as unknown as number);
}
