import { defineCommand } from 'citty';
import { consola } from 'consola';
import { getInnerArgs } from '../inner-args.js';
import { runAddPort } from '../modify/index.js';

export const addPortCommand = defineCommand({
  meta: {
    name: 'add-port',
    group: 'edit',
    description:
      'Add one or more ports to the container config so they become reachable from the host via Traefik (`<container>.localhost` / `<container>-<port>.localhost`). Pass port numbers after `--` (e.g. `monoceros add-port sandbox -- 3000 5173 6006`). Idempotent. Persisted in the yml so later `monoceros apply` runs restore the routes.',
  },
  args: {
    name: {
      type: 'positional',
      description:
        'Container name (yml in $MONOCEROS_HOME/container-configs/).',
      required: true,
    },
    yes: {
      type: 'boolean',
      description: 'Skip the interactive confirmation and apply the diff.',
      alias: ['y'],
      default: false,
    },
  },
  async run({ args }) {
    const tokens = [...getInnerArgs()];
    if (tokens.length === 0) {
      consola.error(
        'No ports given. Usage: `monoceros add-port <containername> [--yes] -- <port> [<port> …]`.',
      );
      process.exit(1);
    }
    try {
      const result = await runAddPort({
        name: args.name,
        ports: tokens.map(coerceToken),
        yes: args.yes,
      });
      process.exit(result.status === 'aborted' ? 1 : 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});

/**
 * Surface non-integer CLI tokens via the same error path as out-of-range
 * ports — `runAddPort` validates the numeric value, but we need to get
 * there with a number-or-string for the message to read naturally.
 */
function coerceToken(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : (raw as unknown as number);
}
