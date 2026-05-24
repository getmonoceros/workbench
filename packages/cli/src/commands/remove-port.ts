import { defineCommand } from 'citty';
import { consola } from 'consola';
import { getInnerArgs } from '../inner-args.js';
import { runRemovePort } from '../modify/index.js';

export const removePortCommand = defineCommand({
  meta: {
    name: 'remove-port',
    group: 'edit',
    description:
      'Remove one or more ports from the container config. Pass port numbers after `--` (e.g. `monoceros remove-port sandbox -- 3000 5173`). Idempotent — ports not present are skipped silently.',
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
        'No ports given. Usage: `monoceros remove-port <containername> [--yes] -- <port> [<port> …]`.',
      );
      process.exit(1);
    }
    try {
      const result = await runRemovePort({
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

function coerceToken(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : (raw as unknown as number);
}
